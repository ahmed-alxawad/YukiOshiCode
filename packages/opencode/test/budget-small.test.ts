import { expect, test } from "bun:test"
import { evaluateBudget } from "../src/budget"

test("a $0.005 limit is not rounded to $0.01 in the stop message", () => {
  const result = evaluateBudget({
    config: { session: 0.005 },
    session: { cost: 0.005, tokens: 0 },
    daily: { cost: 0, tokens: 0 },
    monthly: { cost: 0, tokens: 0 },
    warned: new Set(),
  })
  expect(result.allowed).toBe(false)
  expect(result.exceeded).toContain("$0.0050")
  expect(result.exceeded).not.toContain("$0.01")
})
