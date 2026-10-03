import { describe, expect, test } from "bun:test"
import * as Mode from "../../src/agent/mode"

describe("auto mode", () => {
  test("reads the router's answer, ignoring thinking and extra words", () => {
    expect(Mode.parse("research")).toBe("research")
    expect(Mode.parse("<think>maybe build?</think>\nReasoning.")).toBe("reasoning")
    expect(Mode.parse("Mode: goal")).toBe("goal")
    expect(Mode.parse("I am not sure")).toBeUndefined()
  })

  test("falls back to the message's wording", () => {
    expect(Mode.guess("Plan the migration to the new API")).toBe("plan")
    expect(Mode.guess("Write a plan for splitting this module")).toBe("plan")
    expect(Mode.guess("Research the latest version of Effect and its breaking changes")).toBe("research")
    expect(Mode.guess("Why does the cache miss on the second request?")).toBe("reasoning")
    expect(Mode.guess("Explain the tradeoffs between these two designs")).toBe("reasoning")
    expect(Mode.guess("Migrate the project to Bun and keep going until all tests pass")).toBe("goal")
    expect(Mode.guess("Add a --json flag to the stats command")).toBe("build")
    expect(Mode.guess("use research mode: compare these logging libraries")).toBe("research")
  })

  test("Tab order lists the modes, then auto", () => {
    expect(Mode.ORDER).toEqual(["build", "plan", "goal", "reasoning", "research", "auto"])
  })
})
