import { describe, expect, test } from "bun:test"
import { SessionGoal } from "../../src/session/goal"

describe("SessionGoal", () => {
  test("reads the judge's verdict from its first word", () => {
    expect(SessionGoal.parseVerdict("DONE: all tests pass")).toEqual({ verdict: "done", reason: "all tests pass" })
    expect(SessionGoal.parseVerdict("continue - lint still fails\nmore")).toEqual({
      verdict: "continue",
      reason: "lint still fails",
    })
    expect(SessionGoal.parseVerdict("<think>hmm</think>BLOCKED: needs the API key").verdict).toBe("blocked")
    // An unclear answer pauses instead of looping.
    expect(SessionGoal.parseVerdict("I think it's probably fine").verdict).toBe("blocked")
  })

  test("stores, updates, and clears one goal per session", async () => {
    const id = `ses_goal_test_${Date.now()}`
    expect(await SessionGoal.get(id)).toBeUndefined()
    await SessionGoal.set(id, { objective: "ship it", status: "active", rounds: 0, maxRounds: 5 })
    expect((await SessionGoal.get(id))?.objective).toBe("ship it")
    await SessionGoal.update(id, { rounds: 2, note: "tests missing" })
    expect(await SessionGoal.get(id)).toMatchObject({ rounds: 2, note: "tests missing", status: "active" })
    await SessionGoal.clear(id)
    expect(await SessionGoal.get(id)).toBeUndefined()
  })

  test("describes the goal and the next round", () => {
    const goal = { objective: "ship it", status: "paused" as const, rounds: 3, maxRounds: 20, note: "needs a key", updated: 0 }
    expect(SessionGoal.status(goal)).toContain("Paused goal: ship it")
    expect(SessionGoal.status(goal)).toContain("Why: needs a key")
    expect(SessionGoal.status(undefined)).toContain("No goal is set")
    expect(SessionGoal.continuation(goal, "tests fail")).toContain("round 4 of 20")
  })
})
