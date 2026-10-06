import { describe, expect, it } from "bun:test"
import { validateCron, nextRun } from "../../src/schedule/cron"

describe("schedule cron parser and validator", () => {
  it("validates standard 5-field cron expressions", () => {
    expect(() => validateCron("* * * * *")).not.toThrow()
    expect(() => validateCron("*/15 * * * *")).not.toThrow()
    expect(() => validateCron("0 9 * * 1-5")).not.toThrow()
    expect(() => validateCron("30 14 1 * *")).not.toThrow()
    expect(() => validateCron("0 0 1 1 *")).not.toThrow()
    expect(() => validateCron("15 10 * * MON,WED,FRI")).not.toThrow()
    expect(() => validateCron("0 12 * JAN-DEC SUN")).not.toThrow()
  })

  it("rejects invalid field counts", () => {
    expect(() => validateCron("* * * *")).toThrow("expected 5 fields")
    expect(() => validateCron("* * * * * *")).toThrow("expected 5 fields")
    expect(() => validateCron("")).toThrow("expected 5 fields")
  })

  it("rejects out of range values with clear error messages", () => {
    expect(() => validateCron("60 * * * *")).toThrow("out of range [0, 59] in cron minute")
    expect(() => validateCron("* 24 * * *")).toThrow("out of range [0, 23] in cron hour")
    expect(() => validateCron("* * 0 * *")).toThrow("out of range [1, 31] in cron day-of-month")
    expect(() => validateCron("* * 32 * *")).toThrow("out of range [1, 31] in cron day-of-month")
    expect(() => validateCron("* * * 13 *")).toThrow("out of range [1, 12] in cron month")
    expect(() => validateCron("* * * * 8")).toThrow("out of range [0, 7] in cron day-of-week")
  })

  it("rejects invalid step or range syntax", () => {
    expect(() => validateCron("*/0 * * * *")).toThrow("Invalid step")
    expect(() => validateCron("*/abc * * * *")).toThrow("Invalid step")
    expect(() => validateCron("10-5 * * * *")).toThrow("Range start 10 exceeds end 5")
    expect(() => validateCron("foo * * * *")).toThrow("Invalid numeric value")
  })

  it("calculates next run for minute intervals", () => {
    const from = new Date("2026-10-07T12:00:15Z")
    const next = nextRun("* * * * *", from)
    expect(next.toISOString()).toBe("2026-10-07T12:01:00.000Z")

    const from2 = new Date("2026-10-07T12:00:00Z")
    const next2 = nextRun("*/15 * * * *", from2)
    expect(next2.toISOString()).toBe("2026-10-07T12:15:00.000Z")
  })

  it("calculates next run for daily schedules", () => {
    const from = new Date("2026-10-07T08:00:00Z")
    const next = nextRun("30 14 * * *", from)
    expect(next.toISOString()).toBe("2026-10-07T14:30:00.000Z")

    // After 14:30, triggers next day at 14:30
    const fromLate = new Date("2026-10-07T15:00:00Z")
    const nextLate = nextRun("30 14 * * *", fromLate)
    expect(nextLate.toISOString()).toBe("2026-10-08T14:30:00.000Z")
  })

  it("calculates next run for weekday schedules (1-5)", () => {
    // 2026-10-09 is a Friday
    const fridayAfternoon = new Date("2026-10-09T10:00:00Z")
    const next = nextRun("0 9 * * 1-5", fridayAfternoon)
    // Next weekday is Monday, 2026-10-12
    expect(next.toISOString()).toBe("2026-10-12T09:00:00.000Z")
  })

  it("calculates next run for yearly schedules", () => {
    const from = new Date("2026-05-01T00:00:00Z")
    const next = nextRun("0 0 1 1 *", from)
    expect(next.toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })
})
