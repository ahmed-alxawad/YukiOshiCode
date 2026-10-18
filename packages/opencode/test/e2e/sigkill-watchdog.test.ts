import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"

const unix = process.platform === "linux" ? describe : describe.skip
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const waitFor = async (check: () => boolean, timeout = 3_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("condition timed out")
}

unix("SIGKILL orphan watchdog", () => {
  test("kills a child after its parent is killed without inheriting fd 3", async () => {
    const modulePath = path.resolve(import.meta.dir, "../../src/util/watchdog.ts")
    const code = `
      import { spawnWithWatchdog } from ${JSON.stringify(modulePath)};
      const child = spawnWithWatchdog(["sleep", "60"]);
      const probe = spawnWithWatchdog(["true"]);
      await probe.exited;
      console.log(JSON.stringify({ parent: process.pid, child: child.pid, watchdog: child.watchdog?.pid }));
      setInterval(() => {}, 1000);
    `
    const parent = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] })
    let line = ""
    parent.stdout?.on("data", (chunk: Buffer) => { line += chunk.toString() })
    await waitFor(() => line.includes('"child"'))
    const info = JSON.parse(line.trim()) as { parent: number; child: number; watchdog?: number }
    expect(alive(info.child)).toBe(true)
    process.kill(info.parent, "SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(() => !alive(info.child))
    expect(info.watchdog).toBeDefined()
  }, 10_000)
})
