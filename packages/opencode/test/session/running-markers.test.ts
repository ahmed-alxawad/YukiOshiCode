import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as RunningTurns from "@/session/running"

const module = path.resolve(import.meta.dir, "../../src/session/running.ts")

describe("running-turn markers of several processes", () => {
  beforeEach(() => fs.rmSync(RunningTurns.dir(), { recursive: true, force: true }))
  afterEach(() => fs.rmSync(RunningTurns.dir(), { recursive: true, force: true }))

  test("one process finishing its turn does not remove the marker of another still running one", async () => {
    // A second, real process is running a turn on the session.
    const other = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import * as R from ${JSON.stringify(module)}; R.mark("ses_shared"); console.log("ready"); setInterval(() => {}, 1000)`,
      ],
      { stdout: "pipe", stderr: "ignore", env: process.env },
    )
    try {
      const reader = other.stdout.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
      // This process runs and finishes a turn on the same session.
      RunningTurns.mark("ses_shared")
      expect(RunningTurns.live().map((m) => m.pid).sort()).toEqual([other.pid, process.pid].sort())
      RunningTurns.clear("ses_shared")
      expect(RunningTurns.live().map((m) => m.pid)).toEqual([other.pid])
    } finally {
      other.kill()
    }
  })
})
