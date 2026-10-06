import { describe, expect, test } from "bun:test"
import { evaluateBudget } from "../src/budget"
import { usageTotals } from "@yukioshi/core/usage"

describe("spending limits", () => {
  test("totals sessions and their subagents by period", () => {
    const rows = [
      { id: "root", cost: 2, tokens: { input: 2, output: 3, reasoning: 1 }, time: { created: 1, updated: 100 } },
      {
        id: "child",
        parentID: "root",
        cost: 1,
        tokens: { input: 4, output: 5, reasoning: 0 },
        time: { created: 1, updated: 100 },
      },
      { id: "old", cost: 9, tokens: { input: 9, output: 0, reasoning: 0 }, time: { created: 1, updated: 1 } },
    ]
    expect(usageTotals(rows, undefined, "root")).toEqual({ cost: 3, tokens: 15 })
    expect(usageTotals(rows, 50)).toEqual({ cost: 3, tokens: 15 })
  })

  test("stops at a limit and warns once at 80 percent", () => {
    const warned = new Set<string>()
    const base = { cost: 8, tokens: 80 }
    const first = evaluateBudget({
      config: { session: 10, tokens: { session: 100 } },
      session: base,
      daily: base,
      monthly: base,
      warned,
    })
    expect(first.allowed).toBe(true)
    expect(first.warning).toContain("80%")
    const second = evaluateBudget({
      config: { session: 10, tokens: { session: 100 } },
      session: base,
      daily: base,
      monthly: base,
      warned,
    })
    expect(second.warning).toBeUndefined()
    const blocked = evaluateBudget({
      config: { session: 10 },
      session: { cost: 10, tokens: 0 },
      daily: base,
      monthly: base,
      warned,
    })
    expect(blocked.allowed).toBe(false)
    expect(blocked.exceeded).toContain("Raise budget.session")

    for (const kind of ["session", "daily", "monthly"] as const) {
      const usage = { cost: 0, tokens: 100 }
      const tokenConfig = { tokens: { [kind]: 100 } }
      const tokenBlocked = evaluateBudget({
        config: tokenConfig,
        session: usage,
        daily: usage,
        monthly: usage,
        warned: new Set(),
      })
      expect(tokenBlocked.exceeded).toContain(`Raise budget.tokens.${kind}`)
      const warningUsage = { cost: 0, tokens: 80 }
      const tokenWarning = evaluateBudget({
        config: tokenConfig,
        session: warningUsage,
        daily: warningUsage,
        monthly: warningUsage,
        warned: new Set(),
      })
      expect(tokenWarning.warning).toContain(`Raise budget.tokens.${kind}`)
    }
  })

  test("does nothing when budget is not configured", () => {
    const result = evaluateBudget({
      config: undefined,
      session: { cost: 999, tokens: 999 },
      daily: { cost: 0, tokens: 0 },
      monthly: { cost: 0, tokens: 0 },
      warned: new Set(),
    })
    expect(result).toEqual({ allowed: true, usage: { cost: 999, tokens: 999 } })
  })
})
