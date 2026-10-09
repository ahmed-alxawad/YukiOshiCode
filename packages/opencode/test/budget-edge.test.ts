import { describe, expect, test } from "bun:test"
import { evaluateBudget } from "../src/budget"

const zero = { cost: 0, tokens: 0 }
const run = (input: Partial<Parameters<typeof evaluateBudget>[0]>) =>
  evaluateBudget({ session: zero, daily: zero, monthly: zero, warned: new Set(), ...input })

describe("evaluateBudget boundaries", () => {
  test("one cent below the limit is allowed, exactly at the limit is blocked", () => {
    expect(run({ config: { session: 10 }, session: { cost: 9.99, tokens: 0 } }).allowed).toBe(true)
    const blocked = run({ config: { session: 10 }, session: { cost: 10, tokens: 0 } })
    expect(blocked.allowed).toBe(false)
    expect(blocked.exceeded).toBe(
      "Session budget of $10.00 reached ($10.00 used). Raise budget.session in yukioshi.json to continue.",
    )
  })

  test("warns from exactly 80 percent, not before", () => {
    expect(run({ config: { session: 10 }, session: { cost: 7.99, tokens: 0 } }).warning).toBeUndefined()
    expect(run({ config: { session: 10 }, session: { cost: 8, tokens: 0 } }).warning).toContain("at 80%")
  })

  test("a warning is per period and unit, so a different limit still warns after the first", () => {
    const warned = new Set<string>()
    const usage = { cost: 8, tokens: 80 }
    const first = run({ config: { daily: 10 }, daily: usage, warned })
    expect(first.warning).toContain("Daily budget is at 80%")
    expect(warned.has("daily:cost")).toBe(true)
    const second = run({ config: { daily: 10, monthly: 10 }, daily: usage, monthly: usage, warned })
    expect(second.warning).toContain("Monthly budget is at 80%")
    expect(second.warning).not.toContain("Daily")
  })

  test("several simultaneous warnings are joined into one message", () => {
    const usage = { cost: 9, tokens: 90 }
    const result = run({ config: { session: 10, tokens: { session: 100 } }, session: usage })
    expect(result.allowed).toBe(true)
    expect(result.warning).toContain("$9.00 of $10.00")
    expect(result.warning).toContain("90 tokens of 100 tokens")
    expect(result.warning).toContain("Raise budget.session")
    expect(result.warning).toContain("Raise budget.tokens.session")
  })

  test("a blocked decision wins over warnings and does not consume the warned set", () => {
    const warned = new Set<string>()
    const result = run({
      config: { session: 10, daily: 10 },
      session: { cost: 8, tokens: 0 },
      daily: { cost: 10, tokens: 0 },
      warned,
    })
    expect(result.allowed).toBe(false)
    expect(result.warning).toBeUndefined()
    expect(result.exceeded).toContain("Daily budget")
    expect(warned.size).toBe(0)
  })

  test("the first exceeded period in session, daily, monthly order is the one reported", () => {
    const over = { cost: 5, tokens: 0 }
    const result = run({ config: { daily: 1, monthly: 1, session: 1 }, session: over, daily: over, monthly: over })
    expect(result.exceeded).toContain("Session budget")
  })

  test("cost limits are checked before token limits for the same period", () => {
    const over = { cost: 5, tokens: 500 }
    const result = run({ config: { session: 1, tokens: { session: 1 } }, session: over })
    expect(result.exceeded).toContain("Raise budget.session ")
  })

  test("token amounts are formatted with thousands separators", () => {
    const result = run({ config: { tokens: { monthly: 1_000_000 } }, monthly: { cost: 0, tokens: 1_500_000 } })
    expect(result.exceeded).toContain("1,000,000 tokens")
    expect(result.exceeded).toContain("1,500,000 tokens used")
  })

  test("money is rounded to cents", () => {
    const result = run({ config: { session: 1.005 }, session: { cost: 2.3456, tokens: 0 } })
    expect(result.exceeded).toContain("$2.35 used")
  })

  test("a zero limit blocks everything once configured", () => {
    const result = run({ config: { session: 0 } })
    expect(result.allowed).toBe(false)
  })

  test("a zero limit never produces a warning", () => {
    expect(run({ config: { tokens: { session: 0 } }, session: { cost: 0, tokens: -1 } }).warning).toBeUndefined()
  })

  test("returns the session usage whatever the decision", () => {
    const session = { cost: 1, tokens: 2 }
    expect(run({ config: { session: 100 }, session }).usage).toBe(session)
    expect(run({ config: { session: 1 }, session }).usage).toBe(session)
  })

  test("an empty budget object imposes no limits", () => {
    const huge = { cost: 1e9, tokens: 1e12 }
    expect(run({ config: {}, session: huge, daily: huge, monthly: huge })).toEqual({
      allowed: true,
      warning: undefined,
      usage: huge,
    })
  })

  test("unlimited token config with only cost configured ignores tokens", () => {
    const result = run({ config: { session: 10 }, session: { cost: 1, tokens: 1e12 } })
    expect(result.allowed).toBe(true)
  })
})
