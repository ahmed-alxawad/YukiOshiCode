import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { BackgroundShell } from "@/background/shell"

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

/** `yukioshi tasks`: background shell jobs and background subagents of one session. Read-only. */
export const TasksCommand = effectCmd({
  command: "tasks",
  describe: "list the background jobs and background subagents of a session (read-only)",
  builder: (yargs) =>
    yargs
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
        if (part.type !== "tool" || part.tool !== "task" || part.state.status === "pending") continue
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
