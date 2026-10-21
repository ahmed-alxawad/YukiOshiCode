import { readFileSync } from "node:fs"
import { type ChildProcess, spawn as cpSpawn } from "node:child_process"
import { debuglog } from "node:util"

const debug = debuglog("yukioshi:watchdog")

export interface WatchdogOptions { group?: boolean }
export interface WatchdogHandle { watchdog?: ChildProcess; cleanup: () => void; pid?: number; targetPid?: number }

// Linux start time from /proc, cheap enough to read in the spawn path. macOS has no /proc, and running ps
// here would block the event loop while a fast child exits, so the darwin watchdog records it itself.
function startTime(pid: number): string | undefined {
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
  const linux = process.platform === "linux"
  const expected = linux ? startTime(parent) : ""
  const targetExpected = linux ? startTime(pid) : ""
  // Missing identity data makes a later kill unsafe because either PID may be reused.
  if (linux && (!expected || !targetExpected)) return { cleanup: () => {}, targetPid: pid }
  const script =
    process.platform === "linux"
      ? [
          'parent="$1"; target="$2"; group="$3"; expected="$4"; target_expected="$5"',
          'while [ -r "/proc/$parent/stat" ]; do',
          '  IFS= read -r stat < "/proc/$parent/stat" || break',
          '  rest=${stat##*) }; set -- $rest',
          '  [ "$1" = Z ] && break',
          '  [ -z "$expected" ] || [ "${20}" = "$expected" ] || exit 0',
          "  sleep 0.25",
          "done",
          '[ -r "/proc/$target/stat" ] || exit 0',
          'IFS= read -r stat < "/proc/$target/stat" || exit 0',
          'rest=${stat##*) }; set -- $rest',
          '[ "${20}" = "$target_expected" ] || exit 0',
          'if [ "$group" = 1 ]; then kill -KILL -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
      : [
          // ps only every 20th poll (5 s): a reused parent pid is rare, and 30 watchers each forking ps
          // four times a second is a real load on macOS.
          'parent="$1"; target="$2"; group="$3"',
          'lstart() { set -- $(/bin/ps -o lstart= -p "$1" 2>/dev/null); [ $# -ge 5 ] && echo "$1 $2 $3 $4 $5"; }',
          'expected=$(lstart "$parent"); target_expected=$(lstart "$target")',
          '[ -n "$expected" ] && [ -n "$target_expected" ] || exit 0',
          "n=0",
          'while kill -0 "$parent" 2>/dev/null; do',
          "  n=$((n + 1))",
          '  if [ "$n" -ge 20 ]; then n=0; [ "$(lstart "$parent")" = "$expected" ] || exit 0; fi',
          "  sleep 0.25",
          "done",
          '[ "$(lstart "$target")" = "$target_expected" ] || exit 0',
          'if [ "$group" = 1 ]; then kill -KILL -"$target" 2>/dev/null; fi',
          'kill -KILL "$target" 2>/dev/null',
        ].join("\n")
  let watcher: ChildProcess | undefined
  try {
    watcher = cpSpawn("/bin/sh", ["-c", script, "watchdog", String(parent), String(pid), options.group ? "1" : "0", expected ?? "", targetExpected ?? ""], { detached: true, stdio: "ignore" })
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

