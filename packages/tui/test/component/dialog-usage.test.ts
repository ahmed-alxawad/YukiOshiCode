import { describe, expect, test } from "bun:test"
import { usagePeriods, usageTotals } from "../../src/component/dialog-usage"

const DAY = 24 * 60 * 60 * 1000

function session(updated: number, cost: number, input: number, output: number, reasoning = 0, parentID?: string) {
  return {
    cost,
    tokens: { input, output, reasoning, cache: { read: 0, write: 0 } },
    time: { created: updated, updated },
    parentID,
  }
}

describe("usage", () => {
  test("periods start at local midnight, 7 days ago, and 30 days ago", () => {
    const now = new Date(2026, 9, 3, 15, 30).getTime()
    const [today, week, month] = usagePeriods(now)
    expect(today!.since).toBe(new Date(2026, 9, 3).getTime())
    expect(week!.since).toBe(now - 7 * DAY)
    expect(month!.since).toBe(now - 30 * DAY)
  })

  test("adds tokens and cost into every period a session falls in", () => {
    const now = new Date(2026, 9, 3, 15, 30).getTime()
    const periods = usagePeriods(now)
    const totals = usageTotals(
      [
        session(now - 60_000, 0.5, 1000, 200, 50),
        session(now - 3 * DAY, 1.25, 4000, 1000),
        session(now - 20 * DAY, 2, 10_000, 3000),
        { cost: undefined, tokens: undefined, time: { created: now, updated: now } },
      ],
      periods,
    )
    expect(totals).toEqual([
      { sessions: 2, tokens: 1250, cost: 0.5 },
      { sessions: 3, tokens: 6250, cost: 1.75 },
      { sessions: 4, tokens: 19_250, cost: 3.75 },
    ])
  })

  test("subagent sessions add their usage but are not counted as sessions", () => {
    const now = new Date(2026, 9, 3, 15, 30).getTime()
    const [today] = usageTotals(
      [session(now - 60_000, 1, 1000, 100), session(now - 30_000, 0.25, 500, 50, 0, "ses_parent")],
      usagePeriods(now).slice(0, 1),
    )
    expect(today).toEqual({ sessions: 1, tokens: 1650, cost: 1.25 })
  })
})
