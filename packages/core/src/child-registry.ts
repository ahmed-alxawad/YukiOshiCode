// Every child process YukiOshi starts is registered here, so that when the process itself is told to stop
// (Ctrl-C, SIGTERM from a supervisor, SIGHUP when the terminal closes) none of them is left running on the
// machine. A child started in its own process group is signalled as a group, so grandchildren go with it.
import type { ChildProcess } from "node:child_process"

type Entry = { pid: number; group: boolean }

const live = new Map<number, Entry>()
const hooks = new Set<() => Promise<unknown> | unknown>()
let guarded = false

function send(entry: Entry, signal: NodeJS.Signals) {
  try {
    process.kill(entry.group && process.platform !== "win32" ? -entry.pid : entry.pid, signal)
  } catch {
    // Already gone.
  }
}

function alive(entry: Entry) {
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
  // Last resort, also covers `process.exit()`: nothing registered may outlive this process.
  process.on("exit", () => {
    for (const entry of live.values()) send(entry, "SIGKILL")
  })
}

/** Registers a child. `group` is true when it was started detached (its own process group). */
export function track(proc: Pick<ChildProcess, "pid" | "once">, group: boolean) {
  const pid = proc.pid
  if (typeof pid !== "number") return
  guard()
  live.set(pid, { pid, group })
  proc.once("close", () => live.delete(pid))
  proc.once("exit", () => {
    // A group leader that exited may have left grandchildren behind; they stay registered until the
    // group is empty so a later stop still reaches them.
    const entry = live.get(pid)
    if (entry && !alive(entry)) live.delete(pid)
  })
}

/** Registers a process id started elsewhere. */
export function trackPid(pid: number, group: boolean) {
  guard()
  live.set(pid, { pid, group })
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
