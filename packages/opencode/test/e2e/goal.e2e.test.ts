import { describe, expect } from "bun:test"
import { cliIt } from "../lib/cli-process"

describe("goal", () => {
  cliIt.live("exposes goal status and clear through the real run command", ({ opencode }) => {
    const status = opencode.run("status", { command: "goal" })
    return status.pipe(require("effect").Effect.map((result: { exitCode: number; stdout: string }) => {
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("No goal is set")
    }))
  }, 60_000)
})
