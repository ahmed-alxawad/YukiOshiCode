import { describe, expect, test } from "bun:test"
import { usageTotals, type UsageRow } from "../src/usage"

const row = (id: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  id,
  cost: 1,
  tokens: { input: 1, output: 1, reasoning: 1 },
  time: { created: 0, updated: 100 },
  ...extra,
})

describe("usageTotals", () => {
  test("empty input is zero", () => {
    expect(usageTotals([])).toEqual({ cost: 0, tokens: 0 })
    expect(usageTotals([], 10, "root")).toEqual({ cost: 0, tokens: 0 })
  })

  test("sums cost and all three token kinds across rows", () => {
    expect(usageTotals([row("a"), row("b", { cost: 0.5 })])).toEqual({ cost: 1.5, tokens: 6 })
  })

  test("missing cost and tokens count as zero", () => {
    expect(usageTotals([row("a", { cost: undefined, tokens: undefined }), row("b")])).toEqual({ cost: 1, tokens: 3 })
  })

  test("since filters on the last update, inclusive", () => {
    const rows = [row("old", { time: { created: 0, updated: 49 } }), row("edge", { time: { created: 0, updated: 50 } })]
    expect(usageTotals(rows, 50)).toEqual({ cost: 1, tokens: 3 })
    expect(usageTotals(rows, 0)).toEqual({ cost: 2, tokens: 6 })
    expect(usageTotals(rows, 51)).toEqual({ cost: 0, tokens: 0 })
  })

  test("since of zero is a real filter, not treated as unset", () => {
    expect(usageTotals([row("a", { time: { created: 0, updated: -5 } })], 0)).toEqual({ cost: 0, tokens: 0 })
  })

  test("rootID includes the whole subtree but not siblings or unrelated rows", () => {
    const rows = [
      row("root"),
      row("child", { parentID: "root" }),
      row("grandchild", { parentID: "child" }),
      row("sibling", { parentID: "other" }),
      row("other"),
    ]
    expect(usageTotals(rows, undefined, "root")).toEqual({ cost: 3, tokens: 9 })
    expect(usageTotals(rows, undefined, "child")).toEqual({ cost: 2, tokens: 6 })
    expect(usageTotals(rows, undefined, "other")).toEqual({ cost: 2, tokens: 6 })
  })

  test("an unknown rootID counts nothing", () => {
    expect(usageTotals([row("a")], undefined, "nope")).toEqual({ cost: 0, tokens: 0 })
  })

  test("a parent cycle terminates", () => {
    const rows = [row("a", { parentID: "b" }), row("b", { parentID: "a" })]
    expect(usageTotals(rows, undefined, "a")).toEqual({ cost: 2, tokens: 6 })
  })

  test("a row that is its own parent is counted once", () => {
    expect(usageTotals([row("a", { parentID: "a" })], undefined, "a")).toEqual({ cost: 1, tokens: 3 })
  })

  test("since and rootID combine", () => {
    const rows = [
      row("root"),
      row("child", { parentID: "root", time: { created: 0, updated: 1 } }),
      row("elsewhere"),
    ]
    expect(usageTotals(rows, 50, "root")).toEqual({ cost: 1, tokens: 3 })
  })

  test("a very deep chain does not overflow the stack", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => row(`n${i}`, i === 0 ? {} : { parentID: `n${i - 1}` }))
    expect(usageTotals(rows, undefined, "n0").cost).toBe(50_000)
  })
})
