import { type ChildProcess, spawn as cpSpawn } from "node:child_process"
import type { Writable } from "node:stream"
import launch from "cross-spawn"
import { ChildRegistry } from "@yukioshi/core/child-registry"
import type { Options as ProcessOptions, Child as ProcessChild } from "./process"

export interface WatchdogOptions {
  /**
   * If true, kill the entire process group (-pid) when parent unexpectedly terminates.
   * Defaults to true if the process is detached or group is specified.
   */
  group?: boolean
}

export interface WatchdogHandle {
  watchdog?: ChildProcess
  cleanup: () => void
  /** The watchdog process's own PID */
  pid?: number
  /** The monitored target process's PID */
  targetPid?: number
}

export interface WatchdogSpawnOptions extends ProcessOptions {
  detached?: boolean
  group?: boolean
  watchdog?: boolean
}

export type ChildWithWatchdog = ProcessChild & {
  watchdog?: WatchdogHandle
}

/**
 * Attaches a pipe EOF watchdog monitor to an existing child process or PID on Linux.
 *
 * When the parent process receives SIGKILL (kill -9) or crashes unexpectedly,
 * Node/Bun runtime terminates immediately without running process exit handlers.
 *
 * However, the Linux kernel always automatically closes all file descriptors of the dying process.
 * The watchdog helper holds the read end of a dedicated pipe (fd 3) while the parent holds the write end.
 * When the parent dies, the kernel closes the write end, causing the watchdog to immediately receive EOF.
 * The watchdog then sends SIGKILL to the child process (or child's process group), preventing orphan leaks.
 */
export function attachWatchdog(
  target: Pick<ChildProcess, "pid" | "once"> | number,
  options: WatchdogOptions = {},
): WatchdogHandle {
  if (process.platform === "win32") {
    return { cleanup: () => {} }
  }

  const pid = typeof target === "number" ? target : target.pid
  if (!pid || pid <= 0) {
    return { cleanup: () => {} }
  }

  const group = options.group ?? false

  let cleaned = false
  let watchdogProc: ChildProcess | undefined

  try {
    // The watchdog helper attaches to fd 3 and blocks on read until EOF.
    // When parent dies (SIGKILL), the pipe's write end closes and read returns EOF.
    // The helper then immediately kills the target process or process group.
    const script = `
exec <&3
while read -r _ 2>/dev/null; do :; done
if [ "$2" = "1" ]; then
  kill -TERM -$1 2>/dev/null
  kill -KILL -$1 2>/dev/null
fi
kill -TERM $1 2>/dev/null
kill -KILL $1 2>/dev/null
`

    watchdogProc = cpSpawn(
      "/bin/sh",
      ["-c", script, "watchdog", String(pid), group ? "1" : "0"],
      {
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        detached: true,
      },
    )

    // Unref so the watchdog does not prevent the Node/Bun event loop from exiting naturally
    watchdogProc.unref()
    const pipeStream = watchdogProc.stdio[3] as Writable | undefined
    ;(pipeStream as unknown as { unref?: () => void })?.unref?.()
  } catch {
    // Spawning watchdog helper failed (best-effort)
    return { cleanup: () => {} }
  }

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (watchdogProc) {
      try {
        watchdogProc.kill("SIGKILL")
      } catch {
        // already gone
      }
      try {
        const pipeStream = watchdogProc.stdio[3] as Writable | undefined
        pipeStream?.end()
        pipeStream?.destroy()
      } catch {
        // already closed
      }
    }
  }

  // If a child process object was provided, clean up the watchdog immediately on normal exit
  if (typeof target !== "number" && typeof target.once === "function") {
    target.once("exit", cleanup)
    target.once("close", cleanup)
  }

  return {
    watchdog: watchdogProc,
    cleanup,
    pid: watchdogProc?.pid,
    targetPid: pid,
  }
}

/**
 * Spawns a child process wrapped with a Linux SIGKILL orphan cleanup watchdog.
 *
 * If the parent process is killed abruptly (e.g. SIGKILL), the watchdog terminates
 * the child process and its process group within milliseconds.
 */
export function spawnWithWatchdog(
  cmd: string[],
  opts: WatchdogSpawnOptions = {},
): ChildWithWatchdog {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const detached = opts.detached ?? false
  const group = opts.group ?? detached

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
    detached,
  })

  ChildRegistry.track(proc, group && process.platform !== "win32")

  const enableWatchdog = opts.watchdog !== false && process.platform !== "win32"
  const watchdog = enableWatchdog ? attachWatchdog(proc, { group }) : undefined

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
      watchdog?.cleanup()
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  const child = proc as ChildWithWatchdog
  child.exited = exited
  child.watchdog = watchdog
  return child
}

export * as Watchdog from "./watchdog"
