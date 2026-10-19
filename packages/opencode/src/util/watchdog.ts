import { readFileSync } from "node:fs"
import { type ChildProcess, spawn as cpSpawn } from "node:child_process"
import launch from "cross-spawn"
import { ChildRegistry } from "@yukioshi/core/child-registry"
import type { Options as ProcessOptions, Child as ProcessChild } from "./process"

export interface WatchdogOptions { group?: boolean }
export interface WatchdogHandle { watchdog?: ChildProcess; cleanup: () => void; pid?: number; targetPid?: number }
export interface WatchdogSpawnOptions extends ProcessOptions { detached?: boolean; group?: boolean; watchdog?: boolean }
export type ChildWithWatchdog = ProcessChild & { watchdog?: WatchdogHandle }

function startTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]
  } catch { return undefined }
}

export function attachWatchdog(target: Pick<ChildProcess, "pid" | "once"> | number, options: WatchdogOptions = {}): WatchdogHandle {
  if (process.platform !== "linux" && process.platform !== "darwin") return { cleanup: () => {} }
  const pid = typeof target === "number" ? target : target.pid
  if (!pid || pid <= 0) return { cleanup: () => {} }
  const parent = process.pid
  const expected = startTime(parent) ?? ""
  const script =
    process.platform === "linux"
      ? [
          'parent="$1"; target="$2"; group="$3"; expected="$4"',
          'while [ -r "/proc/$parent/stat" ]; do',
          "  if [ -n \"$expected\" ]; then current=$(sed 's/.*) //' \"/proc/$parent/stat\" 2>/dev/null | awk '{print $20}'); [ \"$current\" = \"$expected\" ] || exit 0; fi",
          "  state=$(sed 's/.*) //' \"/proc/$parent/stat\" 2>/dev/null | awk '{print $1}'); [ \"$state\" = Z ] && break",
          "  sleep 0.1",
          "done",
          'if [ "$group" = 1 ]; then kill -KILL -- -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
      : [
          'parent="$1"; target="$2"; group="$3"',
          'while kill -0 "$parent" 2>/dev/null; do',
          "  sleep 0.1",
          "done",
          'if [ "$group" = 1 ]; then kill -KILL -- -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
  let watcher: ChildProcess | undefined
  try {
    watcher = cpSpawn("/bin/sh", ["-c", script, "watchdog", String(parent), String(pid), options.group ? "1" : "0", expected], { detached: true, stdio: "ignore" })
    watcher.unref()
  } catch { return { cleanup: () => {} } }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (watcher && watcher.exitCode === null) { try { watcher.kill("SIGKILL") } catch {} }
  }
  if (typeof target !== "number") { target.once("exit", cleanup); target.once("close", cleanup) }
  return { watchdog: watcher, cleanup, pid: watcher.pid, targetPid: pid }
}

export function spawnWithWatchdog(cmd: string[], opts: WatchdogSpawnOptions = {}): ChildWithWatchdog {
  if (!cmd.length) throw new Error("Command is required")
  opts.abort?.throwIfAborted()
  const detached = opts.detached ?? false
  const group = opts.group ?? detached
  const proc = launch(cmd[0], cmd.slice(1), { cwd: opts.cwd, shell: opts.shell, env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined, stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"], windowsHide: process.platform === "win32", detached })
  ChildRegistry.track(proc, group && process.platform !== "win32")
  const watchdog = opts.watchdog === false || (process.platform !== "linux" && process.platform !== "darwin") ? undefined : attachWatchdog(proc, { group })
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => { if (closed || proc.exitCode !== null || proc.signalCode !== null) return; closed = true; proc.kill(opts.kill ?? "SIGTERM"); const ms = opts.timeout ?? 5_000; if (ms > 0) timer = setTimeout(() => proc.kill("SIGKILL"), ms) }
  const exited = new Promise<number>((resolve, reject) => {
    const done = () => { opts.abort?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); watchdog?.cleanup() }
    proc.once("exit", (code, signal) => { done(); resolve(code ?? (signal ? 1 : 0)) })
    proc.once("error", (error) => { done(); reject(error) })
  })
  void exited.catch(() => undefined)
  if (opts.abort) { opts.abort.addEventListener("abort", abort, { once: true }); if (opts.abort.aborted) abort() }
  const child = proc as ChildWithWatchdog
  child.exited = exited; child.watchdog = watchdog
  return child
}

export * as Watchdog from "./watchdog"
