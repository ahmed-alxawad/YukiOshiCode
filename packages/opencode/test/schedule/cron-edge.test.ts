import { describe, expect, it } from "bun:test"
import { nextRun, validateCron } from "../../src/schedule/cron"

const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b)

describe("cron field parsing edge cases", () => {
  it("expands lists, ranges and steps", () => {
    expect(sorted(validateCron("1,5,10 * * * *").minutes)).toEqual([1, 5, 10])
    expect(sorted(validateCron("1-10/3 * * * *").minutes)).toEqual([1, 4, 7, 10])
    expect(sorted(validateCron("*/20 * * * *").minutes)).toEqual([0, 20, 40])
    expect(sorted(validateCron("* */6 * * *").hours)).toEqual([0, 6, 12, 18])
    expect(sorted(validateCron("0 0 */10 * *").daysOfMonth)).toEqual([1, 11, 21, 31])
    expect(sorted(validateCron("0-0 * * * *").minutes)).toEqual([0])
    expect(validateCron("*/60 * * * *").minutes.size).toBe(1)
  })

  it("treats N/step as a range from N to the end of the field", () => {
    expect(sorted(validateCron("5/20 * * * *").minutes)).toEqual([5, 25, 45])
    expect(sorted(validateCron("* 20/2 * * *").hours)).toEqual([20, 22])
  })

  it("normalizes day-of-week 7 to Sunday", () => {
    expect(sorted(validateCron("* * * * 7").daysOfWeek)).toEqual([0])
    expect(sorted(validateCron("* * * * 0,7").daysOfWeek)).toEqual([0])
    expect(sorted(validateCron("* * * * 5-7").daysOfWeek)).toEqual([0, 5, 6])
    expect(sorted(validateCron("* * * * 1-5/2").daysOfWeek)).toEqual([1, 3, 5])
  })

  it("accepts names case-insensitively", () => {
    expect(sorted(validateCron("* * * * MON-FRI").daysOfWeek)).toEqual([1, 2, 3, 4, 5])
    expect(sorted(validateCron("* * * * Sun").daysOfWeek)).toEqual([0])
    expect(sorted(validateCron("* * * jan,Dec *").months)).toEqual([1, 12])
  })

  it("does not resolve Object.prototype keys as names", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(() => validateCron(`* * * * ${name}`)).toThrow("Invalid numeric value")
      expect(() => validateCron(`* * * ${name} *`)).toThrow("Invalid numeric value")
    }
  })

  it("tolerates surrounding whitespace and tabs but trims the raw form", () => {
    const parsed = validateCron("  \t5 *\t* * *  ")
    expect(parsed.raw).toBe("5 *\t* * *")
    expect(sorted(parsed.minutes)).toEqual([5])
    expect(validateCron(" ".repeat(100_000) + "* * * * *").minutes.size).toBe(60)
  })

  it("tracks whether day-of-month and day-of-week are restricted", () => {
    expect(validateCron("* * * * *")).toMatchObject({ domRestricted: false, dowRestricted: false })
    expect(validateCron("* * 1 * *")).toMatchObject({ domRestricted: true, dowRestricted: false })
    expect(validateCron("* * * * 1")).toMatchObject({ domRestricted: false, dowRestricted: true })
  })

  it.each([
    "",
    "   ",
    "@daily",
    "@reboot",
    "? * * * *",
    "L * * * *",
    "* * * * 1#2",
    "1,,2 * * * *",
    "1, * * * *",
    ",1 * * * *",
    "-1 * * * *",
    "1- * * * *",
    "-5 * * * *",
    "*-5 * * * *",
    "1-5-7 * * * *",
    "+5 * * * *",
    "1e1 * * * *",
    "0x5 * * * *",
    "1.5 * * * *",
    "05 * * * *",
    "*/ * * * *",
    "*/1/2 * * * *",
    "*/-1 * * * *",
    "5-1/2 * * * *",
    "1-5/0 * * * *",
    "5/0 * * * *",
    "* * * * 8",
    "* * * 0 *",
    "* * 0 * *",
    "１ * * * *",
    "9999999999999999999 * * * *",
    "*/9999999999999999999 * * * *",
    "* * * * * *",
    "* * * *",
    "* * * * *\n* * * * *",
    "* * * * *\r",
    "* * * * *; rm -rf /",
    "* * * * * $(id)",
    "`id` * * * *",
  ])("rejects %p", (expr) => {
    expect(() => validateCron(expr)).toThrow()
  })

  it("rejects a huge field list without hanging", () => {
    const start = Date.now()
    expect(() => validateCron(Array.from({ length: 50_000 }, () => "99").join(",") + " * * * *")).toThrow()
    expect(Date.now() - start).toBeLessThan(2000)
    expect(validateCron(Array.from({ length: 50_000 }, (_, i) => String(i % 60)).join(",") + " * * * *").minutes.size).toBe(60)
  })

  it("reports the offending expression in the error", () => {
    expect(() => validateCron("61 * * * *")).toThrow('Invalid cron expression "61 * * * *"')
  })
})

describe("nextRun edge cases", () => {
  const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms)

  it("never returns the current minute, even at second zero", () => {
    expect(nextRun("* * * * *", local(2026, 10, 1, 0, 0, 0, 0))).toEqual(local(2026, 10, 1, 0, 1))
    expect(nextRun("* * * * *", local(2026, 10, 1, 0, 0, 59, 999))).toEqual(local(2026, 10, 1, 0, 1))
  })

  it("rolls over hour, day, month and year boundaries", () => {
    expect(nextRun("0 0 * * *", local(2026, 12, 31, 23, 59))).toEqual(local(2027, 1, 1, 0, 0))
    expect(nextRun("59 23 * * *", local(2026, 2, 28, 23, 59))).toEqual(local(2026, 3, 1, 23, 59))
  })

  it("finds Feb 29 only in leap years", () => {
    expect(nextRun("0 0 29 2 *", local(2026, 1, 1))).toEqual(local(2028, 2, 29))
  })

  it("skips months that lack the requested day", () => {
    expect(nextRun("0 0 31 * *", local(2026, 4, 1))).toEqual(local(2026, 5, 31))
  })

  it("throws for a date that can never occur instead of looping forever", () => {
    expect(() => nextRun("0 0 31 2 *", local(2026, 1, 1))).toThrow("No matching run time")
    expect(() => nextRun("0 0 30 2 *", local(2026, 1, 1))).toThrow("No matching run time")
  })

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    // 2026-10-01 is a Thursday. "13th OR Friday": the next Friday (Oct 2) wins over the 13th.
    expect(nextRun("0 0 13 * 5", local(2026, 10, 1))).toEqual(local(2026, 10, 2))
    // After Friday the 2nd, next is Friday the 9th, not the 13th.
    expect(nextRun("0 0 13 * 5", local(2026, 10, 2, 1))).toEqual(local(2026, 10, 9))
  })

  it("matches only the restricted field when the other is a wildcard", () => {
    // Sunday 2026-10-04 via both 0 and 7
    expect(nextRun("0 0 * * 7", local(2026, 10, 1))).toEqual(local(2026, 10, 4))
    expect(nextRun("0 0 * * 0", local(2026, 10, 1))).toEqual(local(2026, 10, 4))
    expect(nextRun("0 0 15 * *", local(2026, 10, 1))).toEqual(local(2026, 10, 15))
  })

  it("accepts a pre-parsed expression", () => {
    const parsed = validateCron("30 6 * * *")
    expect(nextRun(parsed, local(2026, 10, 1, 7, 0))).toEqual(local(2026, 10, 2, 6, 30))
  })

  it("propagates validation errors for invalid strings", () => {
    expect(() => nextRun("bogus", local(2026, 1, 1))).toThrow("Invalid cron expression")
  })
})
