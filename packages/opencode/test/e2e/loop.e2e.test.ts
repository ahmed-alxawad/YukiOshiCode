import { describe, expect } from "bun:test"
import { cliIt } from "../lib/cli-process"

describe("loop", () => {
  cliIt.live("reports that the loop is disabled by default", ({ opencode }) => {
    const result = opencode.run("status", { extraArgs: ["--command", "loop"] })
    return result.pipe(require("effect").Effect.map((value: { exitCode: number; stdout: string }) => {
      expect(value.exitCode).toBe(0)
      expect(value.stdout.toLowerCase()).toContain("loop")
    }))
  }, 60_000)
})
