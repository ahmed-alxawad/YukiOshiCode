import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { attachWatchdog } from "@/util/watchdog"

describe("util.watchdog", () => {
  test("returns empty cleanup when target has non-positive or missing pid", () => {
    const handle = attachWatchdog(0)
    expect(handle.watchdog).toBeUndefined()
    expect(typeof handle.cleanup).toBe("function")
    handle.cleanup()
  })

  test("attaches watchdog to a spawned process and cleans up watcher cleanly", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      const handle = attachWatchdog(child)
      if (process.platform === "linux" || process.platform === "darwin") {
        expect(handle.watchdog).toBeDefined()
        expect(handle.pid).toBeDefined()
        expect(handle.targetPid).toBe(child.pid)
      } else {
        expect(handle.watchdog).toBeUndefined()
      }
      handle.cleanup()
      if (handle.watchdog) {
        expect(handle.watchdog.killed || handle.watchdog.signalCode !== null || handle.watchdog.exitCode !== null).toBe(true)
      }
    } finally {
      try { child.kill("SIGKILL") } catch {}
    }
  })
})
