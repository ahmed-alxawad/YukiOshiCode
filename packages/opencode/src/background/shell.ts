// Background shell jobs. A job is one shell command that keeps running while the agent works on.
// This module is the registry: it keeps a bounded output buffer per job, the limits, the kill rules and a small
// state file that `yukioshi tasks` reads. How the command is started (permission, sandbox, environment) is the
// shell tool's business: it passes a `launch` function in.
import fs from "fs"
import path from "path"
import { Global } from "@yukioshi/core/global"

export type State = "running" | "exited" | "stopped" | "expired" | "killed" | "failed"

export interface Job {
  readonly id: string
  readonly sessionID: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  endedAt?: number
  state: State
  exit?: number | null
  pid?: number
  error?: string
  /** Output kept so far. `base` counts the characters dropped from the front. */
  buf: string
  base: number
  /** Next unread position, counted like `base` plus the buffer. */
  cursor: number
  readonly maxMs: number
  readonly waitMs: number
  readonly abort: AbortController
  stopReason?: "stopped" | "expired" | "killed"
  done: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

export interface Io {
  push(chunk: string): void
  setPid(pid: number | undefined): void
  readonly signal: AbortSignal
}

export interface StartInput {
  sessionID: string
  command: string
  cwd: string
  /** Runs the command until it exits or `io.signal` aborts (then it must kill the whole process group). */
  launch: (io: Io) => Promise<number | null>
  maxJobs?: number
  maxMs?: number
  bufferChars?: number
  waitMs?: number
  mask?: (text: string) => string
  /** Called once when the job has ended, whatever the reason. */
  onEnd?: (job: Job) => void
}

export interface Info {
  id: string
  sessionID: string
  command: string
  cwd: string
  state: State
  exit?: number | null
  ageMs: number
  pid?: number
  error?: string
  last: string[]
}

export const DEFAULT_MAX_JOBS = 4
export const DEFAULT_MAX_MS = 30 * 60 * 1000
export const DEFAULT_BUFFER = 1024 * 1024
export const DEFAULT_WAIT_MS = 60 * 1000
const GRACE_MS = 6000
const LAST_LINES = 5

const jobs = new Map<string, Job>()
const caps = new Map<string, { bufferChars: number; mask: (text: string) => string }>()
const listeners = new Set<() => void>()
let counter = 0

function notify() {
  for (const fn of [...listeners]) fn()
}

export function stateDir() {
  return path.join(Global.Path.state, "background-shell")
}

function stateFile(sessionID: string) {
  return path.join(stateDir(), `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

export function lastLines(text: string, count = LAST_LINES) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .map((line) => (line.length > 200 ? line.slice(0, 200) + "..." : line))
}

function info(job: Job): Info {
  const mask = caps.get(job.id)?.mask ?? ((text: string) => text)
  return {
    id: job.id,
    sessionID: job.sessionID,
    command: mask(job.command),
    cwd: job.cwd,
    state: job.state,
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ageMs: (job.endedAt ?? Date.now()) - job.startedAt,
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
    ...(job.error ? { error: job.error } : {}),
    last: lastLines(mask(job.buf.slice(-2000))),
  }
}

/** Writes the jobs of one session to a small file so another process (`yukioshi tasks`) can show them. */
function persist(sessionID: string) {
  try {
    const list = [...jobs.values()].filter((job) => job.sessionID === sessionID)
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    const rows = list.map((job) => ({ ...info(job), startedAt: job.startedAt, endedAt: job.endedAt, owner: process.pid }))
    fs.writeFileSync(stateFile(sessionID), JSON.stringify({ sessionID, jobs: rows }), { mode: 0o600 })
  } catch {
    // The state file only feeds the read-only listing. A write failure must not break a job.
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** Output changes often: the state file is rewritten at most once a second per session. */
function schedulePersist(sessionID: string) {
  if (pending.has(sessionID)) return
  const timer = setTimeout(() => {
    pending.delete(sessionID)
    persist(sessionID)
  }, 1000)
  timer.unref?.()
  pending.set(sessionID, timer)
}

export interface Stored extends Info {
  startedAt: number
  endedAt?: number
  owner: number
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Reads the jobs the state file holds for a session. A job still marked running whose process is gone shows as lost. */
export function readStored(sessionID: string): (Stored & { lost?: boolean })[] {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(sessionID), "utf8")) as { jobs?: Stored[] }
    return (data.jobs ?? []).map((job) => {
      if (job.state !== "running") return job
      const running = job.owner === process.pid ? jobs.has(job.id) : alive(job.owner)
      return running ? job : { ...job, lost: true }
    })
  } catch {
    return []
  }
}

export function running(sessionID?: string) {
  return [...jobs.values()].filter((job) => job.state === "running" && (!sessionID || job.sessionID === sessionID))
}

export function start(input: StartInput): Job {
  const maxJobs = input.maxJobs ?? DEFAULT_MAX_JOBS
  if (running(input.sessionID).length >= maxJobs) {
    throw new Error(
      `Too many background jobs are running (${maxJobs}). Wait for one to finish or stop one with job_stop.`,
    )
  }
  const abort = new AbortController()
  const id = `job_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const job: Job = {
    id,
    sessionID: input.sessionID,
    command: input.command,
    cwd: input.cwd,
    startedAt: Date.now(),
    state: "running",
    buf: "",
    base: 0,
    cursor: 0,
    maxMs: input.maxMs ?? DEFAULT_MAX_MS,
    waitMs: input.waitMs ?? DEFAULT_WAIT_MS,
    abort,
    done: Promise.resolve(),
  }
  const bufferChars = input.bufferChars ?? DEFAULT_BUFFER
  caps.set(id, { bufferChars, mask: input.mask ?? ((text) => text) })
  jobs.set(id, job)
  installExitGuard()

  const io: Io = {
    signal: abort.signal,
    setPid: (pid) => {
      job.pid = pid
    },
    push: (chunk) => {
      job.buf += chunk
      if (job.buf.length > bufferChars) {
        const drop = job.buf.length - bufferChars
        job.buf = job.buf.slice(drop)
        job.base += drop
      }
      notify()
      schedulePersist(job.sessionID)
    },
  }
  job.timer = setTimeout(() => {
    if (job.state !== "running") return
    job.stopReason = "expired"
    abort.abort()
  }, job.maxMs)
  job.timer.unref?.()

  job.done = input
    .launch(io)
    .then(
      (code) => {
        job.exit = code
        job.state = job.stopReason ?? "exited"
      },
      (error: unknown) => {
        job.state = job.stopReason ?? "failed"
        job.error = error instanceof Error ? error.message : String(error)
      },
    )
    .finally(() => {
      if (job.timer) clearTimeout(job.timer)
      job.endedAt = Date.now()
      killGroup(job.pid, "SIGKILL")
      persist(job.sessionID)
      notify()
      try {
        input.onEnd?.(job)
      } catch {
        // A failing observer must not affect the job.
      }
    })
  persist(job.sessionID)
  return job
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined || process.platform === "win32") return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

export function get(id: string, sessionID?: string) {
  const job = jobs.get(id)
  if (!job) return
  if (sessionID && job.sessionID !== sessionID) return
  return job
}

export function list(sessionID?: string): Info[] {
  return [...jobs.values()].filter((job) => !sessionID || job.sessionID === sessionID).map(info)
}

/** Stops one job: SIGTERM to its process group, SIGKILL after a grace period. Resolves once it is gone. */
export async function stop(job: Job, reason: "stopped" | "killed" = "stopped") {
  if (job.state !== "running") return
  job.stopReason ??= reason
  job.abort.abort()
  const force = setTimeout(() => killGroup(job.pid, "SIGKILL"), GRACE_MS - 1000)
  force.unref?.()
  await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, GRACE_MS + 2000).unref?.())])
  clearTimeout(force)
}

export async function stopAll(match: (job: Job) => boolean, reason: "stopped" | "killed" = "killed") {
  await Promise.all(running().filter(match).map((job) => stop(job, reason)))
}

/** Kills every running job of a session. Used when the session ends or is cancelled. */
export function killSession(sessionID: string) {
  return stopAll((job) => job.sessionID === sessionID)
}

/** Kills every running job started in a directory. Used when the project instance is disposed. */
export function killDirectory(directory: string) {
  return stopAll((job) => job.cwd === directory || job.cwd.startsWith(directory + path.sep))
}

export interface Read {
  text: string
  dropped: number
  /** True when the job has ended and everything was read. */
  finished: boolean
}

/** Output since the last read. The read position moves to the end. */
export function read(job: Job, options: { match?: RegExp } = {}): Read {
  const mask = caps.get(job.id)?.mask ?? ((text: string) => text)
  const from = Math.max(job.cursor, job.base)
  const dropped = from - job.cursor
  let text = mask(job.buf.slice(from - job.base))
  job.cursor = job.base + job.buf.length
  if (options.match) {
    const re = options.match
    text = text
      .split("\n")
      .filter((line) => re.test(line))
      .join("\n")
  }
  return { text, dropped, finished: job.state !== "running" }
}

/** Unread output, masked, without moving the read position. */
function unread(job: Job) {
  const mask = caps.get(job.id)?.mask ?? ((text: string) => text)
  return mask(job.buf.slice(Math.max(job.cursor, job.base) - job.base))
}

export type WaitEnd = "match" | "exit" | "timeout" | "abort"

/** Waits for a line matching `until` in the unread output, for the job to end, or for the timeout. */
export function wait(
  job: Job,
  options: { until?: RegExp; any?: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<WaitEnd> {
  return new Promise((resolve) => {
    const check = (): WaitEnd | undefined => {
      if (options.until && unread(job).split("\n").some((line) => options.until!.test(line))) return "match"
      if (options.any && unread(job).length > 0) return "match"
      if (job.state !== "running") return "exit"
    }
    const first = check()
    if (first) return resolve(first)
    const finish = (end: WaitEnd) => {
      clearTimeout(timer)
      listeners.delete(onChange)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(end)
    }
    const onChange = () => {
      const end = check()
      if (end) finish(end)
    }
    const onAbort = () => finish("abort")
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs)
    listeners.add(onChange)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export interface Settled {
  started: number
  finished: number
  killed: number
}

/**
 * At the end of `yukioshi run`: waits for running jobs up to the longest wait they asked for, then kills what is left.
 * Returns undefined when no job was started in this process.
 */
export async function settle(): Promise<Settled | undefined> {
  const all = [...jobs.values()]
  if (all.length === 0) return undefined
  const begun = Date.now()
  const due = (job: Job) => Date.now() >= begun + job.waitMs
  while (running().some((job) => !due(job))) {
    const soonest = Math.min(...running().map((job) => begun + job.waitMs - Date.now()))
    await Promise.race([
      Promise.all(running().map((job) => job.done)),
      new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(250, soonest)))),
    ])
    // A job whose own wait is over is killed now, even while others still wait.
    await Promise.all(running().filter(due).map((job) => stop(job, "killed")))
  }
  await Promise.all(running().map((job) => stop(job, "killed")))
  return {
    started: all.length,
    finished: all.filter((job) => job.state === "exited").length,
    killed: all.filter((job) => job.state === "killed" || job.state === "stopped" || job.state === "expired").length,
  }
}

let guarded = false
/** Last resort: when the process exits, kill every group that is still running. */
function installExitGuard() {
  if (guarded) return
  guarded = true
  process.on("exit", () => {
    for (const job of jobs.values()) if (job.state === "running") killGroup(job.pid, "SIGKILL")
  })
}

/** For tests. */
export function reset() {
  for (const job of jobs.values()) {
    if (job.timer) clearTimeout(job.timer)
    if (job.state === "running") killGroup(job.pid, "SIGKILL")
  }
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  jobs.clear()
  caps.clear()
}

export * as BackgroundShell from "./shell"
