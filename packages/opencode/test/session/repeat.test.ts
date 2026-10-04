import { describe, expect, test } from "bun:test"
import { SessionRepeat } from "../../src/session/repeat"

describe("SessionRepeat", () => {
  test("parses intervals", () => {
    expect(SessionRepeat.parseInterval("90s")).toBe(90_000)
    expect(SessionRepeat.parseInterval("5m")).toBe(300_000)
    expect(SessionRepeat.parseInterval("1h30m")).toBe(5_400_000)
    expect(SessionRepeat.parseInterval("2d")).toBe(172_800_000)
    expect(SessionRepeat.parseInterval("check")).toBeUndefined()
    expect(SessionRepeat.parseInterval("0m")).toBeUndefined()
    expect(SessionRepeat.parseInterval("5")).toBeUndefined()
  })

  test("reads /loop arguments", () => {
    expect(SessionRepeat.parse("")).toEqual({ kind: "status" })
    expect(SessionRepeat.parse("STOP")).toEqual({ kind: "stop" })
    expect(SessionRepeat.parse("5m check the deploy")).toEqual({
      kind: "start",
      intervalMs: 300_000,
      prompt: "check the deploy",
      clamped: false,
    })
    // No interval: the default, and the whole text is the prompt.
    expect(SessionRepeat.parse("/review")).toEqual({
      kind: "start",
      intervalMs: SessionRepeat.DEFAULT_INTERVAL_MS,
      prompt: "/review",
      clamped: false,
    })
    // Shorter than the minimum is raised to it.
    expect(SessionRepeat.parse("10s ping", 60)).toEqual({ kind: "start", intervalMs: 60_000, prompt: "ping", clamped: true })
    expect(SessionRepeat.parse("5m").kind).toBe("invalid")
  })

  test("describes the loop", () => {
    expect(SessionRepeat.duration(5_400_000)).toBe("1h30m")
    expect(SessionRepeat.duration(90_000)).toBe("1m30s")
    const text = SessionRepeat.status(
      { prompt: "check CI", intervalMs: 300_000, runs: 2, maxRuns: 50, nextAt: 1_000 + 120_000 },
      undefined,
      1_000,
    )
    expect(text).toContain("Looping every 5m: check CI")
    expect(text).toContain("Runs: 2 of 50")
    expect(text).toContain("Next run in 2m")
    expect(SessionRepeat.status(undefined, "Stopped: you interrupted a run.")).toStartWith("Stopped: you interrupted")
  })
})
