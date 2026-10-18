import { describe, expect, test } from "bun:test"
import { formatMetric, parseArgs, summarize } from "../script/bench"

describe("CLI benchmark helpers", () => {
  test("uses nearest-rank median and p90 with stable extrema", () => {
    expect(summarize([8, 1, 4, 2, 10, 6, 3, 9, 5, 7])).toEqual({ median: 5, p90: 9, min: 1, max: 10 })
  })

  test("defaults to ten samples and formats every required statistic", () => {
    expect(parseArgs([])).toEqual({ runs: 10, binary: undefined })
    expect(formatMetric("turn", [1, 2, 3])).toContain("median=2.0ms p90=3.0ms min=1.0ms max=3.0ms")
  })
})
