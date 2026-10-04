import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@yukioshi/core/v1/session"
import { ToolLimits } from "../../src/session/tool-limits"

const user = () => ({ info: { role: "user" }, parts: [] }) as unknown as SessionV1.WithParts
const step = (...calls: [string, unknown, string][]) =>
  ({
    info: { role: "assistant" },
    parts: calls.map(([tool, input, output]) => ({ type: "tool", tool, state: { status: "completed", input, output } })),
  }) as unknown as SessionV1.WithParts

describe("ToolLimits", () => {
  test("counts earlier calls in this turn with the same tool, input, and result", () => {
    const messages = [
      user(),
      step(["read", { filePath: "a.ts" }, "old"]), // an earlier turn does not count
      user(),
      step(["read", { filePath: "a.ts", limit: 10 }, "text"]),
      step(["read", { limit: 10, filePath: "a.ts" }, "text" + ToolLimits.nudge("read", 3)]),
      step(["read", { filePath: "a.ts", limit: 10 }, "changed"], ["grep", { filePath: "a.ts", limit: 10 }, "text"]),
    ]
    expect(ToolLimits.priorRepeats(messages, "read", { filePath: "a.ts", limit: 10 }, "text")).toBe(2)
    // Same input with a new result (tests re-run after an edit) is not a repeat.
    expect(ToolLimits.priorRepeats(messages, "read", { filePath: "a.ts", limit: 10 }, "new")).toBe(0)
  })

  test("nudges from the third identical call, more firmly from the fifth", () => {
    expect(ToolLimits.nudge("read", 2)).toBe("")
    expect(ToolLimits.nudge("read", 3)).toContain("3rd time this turn")
    expect(ToolLimits.nudge("read", 5)).toContain("Stop repeating this call")
    expect(ToolLimits.nudge("read", 22)).toContain("22 times")
    expect(ToolLimits.stripNudge("result" + ToolLimits.nudge("read", 4))).toBe("result")
  })

  test("resolves per-tool time limits", () => {
    expect(ToolLimits.timeoutFor(undefined, "read")).toBeUndefined()
    expect(ToolLimits.timeoutFor({ timeout: 60_000 }, "webfetch")).toBe(60_000)
    // A catch-all limit skips tools that time themselves or wait on a person or subagent.
    expect(ToolLimits.timeoutFor({ timeout: 60_000 }, "bash")).toBeUndefined()
    const limits = { timeout: { "*": 120_000, webfetch: 30_000, task: 600_000, grep: 0 } }
    expect(ToolLimits.timeoutFor(limits, "webfetch")).toBe(30_000)
    expect(ToolLimits.timeoutFor(limits, "read")).toBe(120_000)
    expect(ToolLimits.timeoutFor(limits, "question")).toBeUndefined()
    expect(ToolLimits.timeoutFor(limits, "task")).toBe(600_000)
    expect(ToolLimits.timeoutFor(limits, "grep")).toBeUndefined()
    expect(ToolLimits.timeoutMessage("webfetch", 30_000)).toContain("within 30 s")
  })
})
