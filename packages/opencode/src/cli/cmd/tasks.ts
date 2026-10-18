import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { BackgroundShell } from "@/background/shell"
import * as RunningTurns from "@/session/running"
import * as Goal from "@/session/goal"
import { Global } from "@yukioshi/core/global"
import fs from "fs"
import path from "path"

function age(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

interface Row {
  kind: "shell" | "subagent"
  id: string
  state: string
  age: string
  summary: string
  last?: string[]
}

/** An active goal counts as running only while it keeps being updated (a crashed process leaves the file behind). */
export const GOAL_FRESH_MS = 120_000

export interface RunningSession {
  sessionID: string
  project: string
  directory: string
  title: string
  parentID?: string
  /** What is running: a turn, a goal, background shell jobs, or a subagent (a child session with a running turn). */
  state: string[]
  shellJobs: number
  age: string
  ageMs: number
}

function ids(dir: string) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
  } catch {
    return []
  }
}

/** Sessions of this machine that have a running turn, goal, background shell job or subagent. Reads state files only. */
export const collectRunning = Effect.fn("Cli.tasks.collectRunning")(function* (now = Date.now()) {
  const sessions = yield* Session.Service
  const found = new Map<string, { turn?: number; goal?: boolean; shells: number; startedAt: number[] }>()
  const entry = (id: string) => {
    let value = found.get(id)
    if (!value) found.set(id, (value = { shells: 0, startedAt: [] }))
    return value
  }
  for (const marker of RunningTurns.live()) {
    const e = entry(marker.sessionID)
    e.turn = marker.pid
    e.startedAt.push(marker.startedAt)
  }
  for (const id of ids(BackgroundShell.stateDir())) {
    const running = BackgroundShell.readStored(id).filter((job) => job.state === "running" && !job.lost)
    if (running.length === 0) continue
    const e = entry(id)
    e.shells = running.length
    e.startedAt.push(...running.map((job) => job.startedAt))
  }
  for (const id of ids(path.join(Global.Path.state, "goals"))) {
    const goal = yield* Effect.promise(() => Goal.get(id))
    if (!goal || goal.status !== "active" || now - goal.updated > GOAL_FRESH_MS) continue
    entry(id).goal = true
    entry(id).startedAt.push(goal.updated)
  }
  const rows: RunningSession[] = []
  for (const [id, e] of found) {
    const session = yield* sessions.get(id as SessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!session) continue
    const state = [
      ...(e.turn !== undefined ? [session.parentID ? "subagent" : "turn"] : []),
      ...(e.goal ? ["goal"] : []),
      ...(e.shells > 0 ? ["shell"] : []),
    ]
    const since = e.startedAt.length ? Math.min(...e.startedAt) : session.time.created
    rows.push({
      sessionID: id,
      project: path.basename(session.directory) || session.directory,
      directory: session.directory,
      title: session.title,
      ...(session.parentID ? { parentID: session.parentID } : {}),
      state,
      shellJobs: e.shells,
      age: age(now - since),
      ageMs: Math.max(0, now - since),
    })
  }
  return rows.sort((a, b) => a.ageMs - b.ageMs)
})

/** `yukioshi tasks`: background shell jobs and background subagents of one session. Read-only. */
export const TasksCommand = effectCmd({
  command: "tasks",
  describe: "list the background jobs and background subagents of a session, or with --all every running session (read-only)",
  instance: (args) => !args.all,
  builder: (yargs: Argv) =>
    yargs
      .option("all", {
        describe: "list every session of this machine that is running something now (turn, goal, shell job, subagent)",
        type: "boolean",
        default: false,
      })
      .option("session", {
        alias: ["s"],
        describe: "session id (default: the latest session of this project)",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.tasks")(function* (args) {
    if (args.all) {
      const rows = yield* collectRunning()
      if (args.format === "json") {
        process.stdout.write(JSON.stringify({ sessions: rows }, null, 2) + "\n")
        return
      }
      if (rows.length === 0) {
        process.stdout.write("No running sessions.\n")
        return
      }
      for (const row of rows) {
        process.stdout.write(
          `${row.sessionID}  ${row.state.join("+") || "-"}  ${row.age}  ${row.project}  ${row.title}\n`,
        )
      }
      return
    }
    const sessions = yield* Session.Service
    let id = args.session as string | undefined
    if (!id) {
      const latest = (yield* sessions.list({ roots: true, limit: 1 }))[0]
      if (!latest) return yield* fail("No sessions found. Pass --session.")
      id = latest.id
    }
    const sessionID = id as SessionID
    const session = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!session) return yield* fail(`Session not found: ${id}`)

    const rows: Row[] = []
    for (const job of BackgroundShell.readStored(id)) {
      rows.push({
        kind: "shell",
        id: job.id,
        state: job.lost ? "lost" : job.state === "exited" ? `exited (${job.exit ?? "?"})` : job.state,
        age: age((job.endedAt ?? Date.now()) - job.startedAt),
        summary: job.command,
        last: job.last,
      })
    }

    // A background subagent is a child session that a task call with background: true started.
    const messages = yield* sessions.messages({ sessionID }).pipe(Effect.catch(() => Effect.succeed([])))
    const background = new Set<string>()
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "tool" || (part.tool !== "task" && part.tool !== "task_message") || part.state.status === "pending") continue
        const meta = part.state.metadata as Record<string, unknown> | undefined
        if (meta?.background === true && typeof meta.sessionId === "string") background.add(meta.sessionId)
      }
    }
    for (const child of yield* sessions.children(sessionID)) {
      if (!background.has(child.id)) continue
      const idle = Date.now() - child.time.updated > 15_000
      rows.push({
        kind: "subagent",
        id: child.id,
        state: idle ? "idle" : "active",
        age: age(Date.now() - child.time.created),
        summary: child.title,
      })
    }

    if (args.format === "json") {
      process.stdout.write(JSON.stringify({ sessionID: id, tasks: rows }, null, 2) + "\n")
      return
    }
    if (rows.length === 0) {
      process.stdout.write("No background jobs or subagents.\n")
      return
    }
    for (const row of rows) {
      process.stdout.write(`${row.kind.padEnd(8)} ${row.id}  ${row.state}  ${row.age}  ${row.summary}\n`)
      for (const line of row.last ?? []) process.stdout.write(`    ${line}\n`)
    }
  }),
})
