import { describe, expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// Windows has no POSIX SIGKILL or process groups, so this behavior cannot exist there.
const unix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    }
    if (process.platform === "darwin") {
      const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()
      if (state.startsWith("Z")) return false
    }
    return true
  } catch {
    return false
  }
}
const waitFor = async (check: () => boolean, timeout = 2_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("condition timed out")
}

unix("SIGKILL orphan watchdog", () => {
  test("kills 30 children after its parent is killed without breaking later spawns", async () => {
    const modulePath = path.resolve(import.meta.dir, "../../src/util/process.ts")
    const code = `
      import { Process } from ${JSON.stringify(modulePath)};
      const children = Array.from({ length: 30 }, () => Process.spawn(["sleep", "60"]));
      const probe = Process.spawn(["true"]);
      await probe.exited;
      console.log(JSON.stringify({
        parent: process.pid,
        children: children.map((child) => child.pid),
        watchdogs: children.map((child) => child.watchdog?.pid),
      }));
      setInterval(() => {}, 1000);
    `
    const parent = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] })
    let line = ""
    parent.stdout?.on("data", (chunk: Buffer) => { line += chunk.toString() })
    let children: number[] = []
    let watchdogs: number[] = []
    try {
      await waitFor(() => line.includes('"children"'))
      const record = line.split("\n").find((value) => value.includes('"children"'))
      const info = JSON.parse(record ?? "") as { parent: number; children: number[]; watchdogs: Array<number | undefined> }
      children = info.children
      watchdogs = info.watchdogs.filter((pid): pid is number => pid !== undefined)
      expect(children).toHaveLength(30)
      expect(children.every(alive)).toBe(true)
      expect(watchdogs).toHaveLength(30)
      process.kill(info.parent, "SIGKILL")
      await waitFor(() => children.every((pid) => !alive(pid)))
    } finally {
      try { parent.kill("SIGKILL") } catch {}
      for (const pid of children) try { process.kill(pid, "SIGKILL") } catch {}
      for (const pid of watchdogs) try { process.kill(pid, "SIGKILL") } catch {}
    }
  }, 15_000)
})
