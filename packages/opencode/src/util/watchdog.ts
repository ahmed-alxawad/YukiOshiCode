import { readFileSync } from "node:fs"
import { type ChildProcess, execFileSync, spawn as cpSpawn } from "node:child_process"
import { debuglog } from "node:util"

const debug = debuglog("yukioshi:watchdog")

export interface WatchdogOptions { group?: boolean }
export interface WatchdogHandle { watchdog?: ChildProcess; cleanup: () => void; pid?: number; targetPid?: number }

function startTime(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]
    }
    if (process.platform === "darwin") {
      // Darwin exposes process start time only to the second; this still prevents ordinary PID reuse,
      // while Windows remains unsupported because it has neither POSIX SIGKILL nor process groups.
      return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
        .trim()
        .split(/\s+/)
        .join(" ")
    }
    return undefined
  } catch { return undefined }
}

export function attachWatchdog(target: Pick<ChildProcess, "pid" | "once"> | number, options: WatchdogOptions = {}): WatchdogHandle {
  if (process.platform !== "linux" && process.platform !== "darwin") return { cleanup: () => {} }
  const pid = typeof target === "number" ? target : target.pid
  if (!pid || pid <= 0) return { cleanup: () => {} }
  const parent = process.pid
  const expected = startTime(parent)
  const targetExpected = startTime(pid)
  // Missing identity data makes a later kill unsafe because either PID may be reused.
  if (!expected || !targetExpected) return { cleanup: () => {}, targetPid: pid }
  const script =
    process.platform === "linux"
      ? [
          'parent="$1"; target="$2"; group="$3"; expected="$4"; target_expected="$5"',
          'while [ -r "/proc/$parent/stat" ]; do',
          '  IFS= read -r stat < "/proc/$parent/stat" || break',
          '  rest=${stat##*) }; set -- $rest',
          '  [ "$1" = Z ] && break',
          '  [ -z "$expected" ] || [ "${20}" = "$expected" ] || exit 0',
          "  sleep 0.1",
          "done",
          '[ -r "/proc/$target/stat" ] || exit 0',
          'IFS= read -r stat < "/proc/$target/stat" || exit 0',
          'rest=${stat##*) }; set -- $rest',
          '[ "${20}" = "$target_expected" ] || exit 0',
          'if [ "$group" = 1 ]; then kill -KILL -- -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
      : [
          'parent="$1"; target="$2"; group="$3"; expected="$4"; target_expected="$5"',
          'while kill -0 "$parent" 2>/dev/null; do',
          '  current=$(/bin/ps -o lstart= -p "$parent" 2>/dev/null)',
          '  set -- $current; current="$1 $2 $3 $4 $5"',
          '  [ "$current" = "$expected" ] || exit 0',
          "  sleep 0.25",
          "done",
          'current=$(/bin/ps -o lstart= -p "$target" 2>/dev/null)',
          'set -- $current; current="$1 $2 $3 $4 $5"',
          '[ "$current" = "$target_expected" ] || exit 0',
          'if [ "$group" = 1 ]; then kill -KILL -- -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
  let watcher: ChildProcess | undefined
  try {
    watcher = cpSpawn("/bin/sh", ["-c", script, "watchdog", String(parent), String(pid), options.group ? "1" : "0", expected, targetExpected], { detached: true, stdio: "ignore" })
    watcher.once("error", (error) => debug("failed to start orphan watchdog: %s", error.message))
    watcher.unref()
  } catch (error) {
    debug("failed to start orphan watchdog: %s", error instanceof Error ? error.message : String(error))
    return { cleanup: () => {}, targetPid: pid }
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (watcher && watcher.exitCode === null) { try { watcher.kill("SIGKILL") } catch {} }
  }
  if (typeof target !== "number") { target.once("exit", cleanup); target.once("close", cleanup) }
  return { watchdog: watcher, cleanup, pid: watcher.pid, targetPid: pid }
}

export * as Watchdog from "./watchdog"
