// Every child process YukiOshi starts is registered here, so that when the process itself is told to stop
// (Ctrl-C, SIGTERM from a supervisor, SIGHUP when the terminal closes) none of them is left running on the
// machine. A child started in its own process group is signalled as a group, so grandchildren go with it.
import type { ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { isMainThread } from "node:worker_threads"

// `leaderGone` marks a group whose leader has exited and been reaped while other members may live on.
type Entry = { pid: number; group: boolean; killOnExit: boolean; identity?: string; leaderGone?: boolean }

const live = new Map<number, Entry>()
const hooks = new Set<() => Promise<unknown> | unknown>()
let guarded = false

// Worker threads have their own copy of this module, but a signal only reaches the main thread. A worker
// therefore reports every child it starts or releases to the main thread, which keeps the list that
// the signal handlers act on. The channel is separate from the worker's own message port, so it cannot
// disturb any protocol spoken over that.
type Report =
  | { op: "track"; pid: number; group: boolean; killOnExit: boolean }
  | { op: "untrack"; pid: number }
  | { op: "leaderGone"; pid: number }
let channel: BroadcastChannel | undefined
function reports() {
  if (channel) return channel
  try {
    channel = new BroadcastChannel("yukioshi.child-registry")
    if (isMainThread) {
      channel.onmessage = (event: { data: unknown }) => {
        const report = event.data as Report | undefined
        if (report?.op === "track" && typeof report.pid === "number")
          live.set(report.pid, { pid: report.pid, group: report.group, killOnExit: report.killOnExit, identity: processIdentity(report.pid) })
        else if (report?.op === "untrack" && typeof report.pid === "number") live.delete(report.pid)
        else if (report?.op === "leaderGone" && typeof report.pid === "number") {
          const entry = live.get(report.pid)
          if (entry) entry.leaderGone = true
        }
      }
    }
    ;(channel as unknown as { unref?: () => void }).unref?.()
  } catch {
    channel = undefined
  }
  return channel
}
function report(message: Report) {
  if (isMainThread) return
  try {
    reports()?.postMessage(message)
  } catch {
    // Reporting is best effort.
  }
}

function processIdentity(pid: number) {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

function isSameProcess(entry: Entry) {
  if (process.platform !== "linux") return true
  const current = processIdentity(entry.pid)
  // The kernel does not hand out a pid that is still some group's id, so while the group lives on no
  // process may hold the old leader's pid. One that does means the group emptied and the pid was reused.
  if (entry.leaderGone) return entry.identity !== undefined && current === undefined
  return entry.identity !== undefined && current !== undefined && current === entry.identity
}

function send(entry: Entry, signal: NodeJS.Signals) {
  if (!isSameProcess(entry)) return
  try {
    process.kill(entry.group && process.platform !== "win32" ? -entry.pid : entry.pid, signal)
  } catch {
    // Already gone.
  }
}

function alive(entry: Entry) {
  if (!isSameProcess(entry)) return false
  try {
    process.kill(entry.group && process.platform !== "win32" ? -entry.pid : entry.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function guard() {
  if (guarded) return
  guarded = true
  if (isMainThread) reports()
  // Last resort, also covers `process.exit()`: nothing registered may outlive this process.
  process.on("exit", () => {
    for (const entry of live.values()) if (entry.killOnExit) send(entry, "SIGKILL")
  })
}

/** Registers a child. `group` is true when it was started detached (its own process group). */
export function track(proc: Pick<ChildProcess, "pid" | "once">, group: boolean, killOnExit = true) {
  const pid = proc.pid
  if (typeof pid !== "number") return
  guard()
  prune()
  live.set(pid, { pid, group, killOnExit, identity: processIdentity(pid) })
  report({ op: "track", pid, group, killOnExit })
  // A group leader that exited may have left grandchildren behind; the group stays registered until it
  // is empty (or released with `untrack`) so a later stop still reaches them.
  const settle = () => {
    const entry = live.get(pid)
    if (!entry) return
    if (entry.group) {
      entry.leaderGone = true
      report({ op: "leaderGone", pid })
      if (alive(entry)) return
    }
    live.delete(pid)
    report({ op: "untrack", pid })
  }
  proc.once("exit", settle)
  proc.once("close", settle)
}

// Forgets groups whose leader is gone and whose last member has since exited.
function prune() {
  for (const entry of live.values()) if (entry.leaderGone && !alive(entry)) live.delete(entry.pid)
}

/** Registers a process id started elsewhere. */
export function trackPid(pid: number, group: boolean, identity = processIdentity(pid)) {
  guard()
  live.set(pid, { pid, group, killOnExit: true, identity })
  report({ op: "track", pid, group, killOnExit: true })
}

/**
 * Runs `fn` first when the process is told to stop (before children are signalled), for a graceful stop such as
 * aborting the running session. It gets about two seconds. Returns a function that removes the hook.
 */
export function onStop(fn: () => Promise<unknown> | unknown) {
  hooks.add(fn)
  return () => void hooks.delete(fn)
}

export function untrack(pid: number) {
  live.delete(pid)
  report({ op: "untrack", pid })
}

export function count() {
  return live.size
}

/**
 * Stops every registered child: SIGTERM, then SIGKILL for whatever is still there after `graceMs`.
 * Resolves once none is left (or after the SIGKILL).
 */
export async function terminateAll(graceMs = 2_000) {
  const entries = [...live.values()]
  for (const entry of entries) send(entry, "SIGTERM")
  const until = Date.now() + graceMs
  while (Date.now() < until && entries.some(alive)) await new Promise((resolve) => setTimeout(resolve, 50))
  for (const entry of entries) if (alive(entry)) send(entry, "SIGKILL")
  for (const entry of entries) live.delete(entry.pid)
}

async function gracefulStop() {
  const pending = [...hooks].map((fn) => Promise.resolve().then(fn).catch(() => undefined))
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 2_000))])
  await terminateAll()
}

const exitCodes: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

/**
 * Makes SIGTERM and SIGHUP (and SIGINT when asked) stop all registered children before exiting with the
 * conventional 128+n code. Stays silent: it adds no terminal output.
 */
export function stopOnSignals(signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"], exit: (code: number) => void = (code) => process.exit(code)) {
  let stopping = false
  // Start listening for children that worker threads report, and make sure they die with this process.
  guard()
  for (const name of signals) {
    process.on(name, () => {
      if (name === "SIGINT" && process.listenerCount("SIGINT") > 1) return
      if (stopping) return
      stopping = true
      // SIGINT with another listener installed means an interactive screen owns Ctrl-C and decides itself.
      void gracefulStop().finally(() => exit(exitCodes[name] ?? 1))
    })
  }
}

export * as ChildRegistry from "./child-registry"
