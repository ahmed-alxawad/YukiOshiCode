// Tool limits: a nudge when the model keeps repeating the same tool call, and optional time limits per
// tool. A call counts as a repeat only when the tool, its input, and its result all match an earlier call
// in the same turn, so re-running tests after an edit (same input, new result) is never flagged.

import type { SessionV1 } from "@yukioshi/core/v1/session"

/** The nudge starts on the third identical call in a turn. */
export const REPEAT_NUDGE_AT = 3
const STRONG_NUDGE_AT = 5
const MARKER = "\n\n[Repeated call] "

/**
 * Tools left out of a catch-all (`"*"`) timeout: they keep their own time limit (bash) or wait on a
 * person or a subagent. Naming one of them explicitly still applies a limit.
 */
const TIMEOUT_EXEMPT = new Set(["bash", "task", "task_parallel", "question", "plan_exit"])

export interface Limits {
  readonly repeat_nudge?: boolean
  readonly timeout?: number | Readonly<Record<string, number>>
}

/** JSON with sorted keys, so `{a, b}` and `{b, a}` compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** The tool's result without a nudge added earlier. */
export function stripNudge(output: string) {
  const index = output.indexOf(MARKER)
  return index === -1 ? output : output.slice(0, index)
}

/** How many earlier calls in the current turn had this tool, input, and result. */
export function priorRepeats(messages: readonly SessionV1.WithParts[], tool: string, input: unknown, output: string) {
  const lastUser = messages.findLastIndex((message) => message.info.role === "user")
  const key = stable(input)
  const result = stripNudge(output)
  let count = 0
  for (const message of messages.slice(lastUser + 1)) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== tool || part.state.status !== "completed") continue
      if (stable(part.state.input) === key && stripNudge(part.state.output) === result) count++
    }
  }
  return count
}

/** The note added to a repeated call's result, or "" when it is not repeated often enough. */
export function nudge(tool: string, calls: number) {
  if (calls < REPEAT_NUDGE_AT) return ""
  const tens = calls % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[calls % 10]
  const ordinal = `${calls}${suffix ?? "th"}`
  return calls < STRONG_NUDGE_AT
    ? `${MARKER}This is the ${ordinal} time this turn that ${tool} ran with the same input and returned the same result. Use the result you already have instead of calling it again. If you are stuck, try a different approach or say what is blocking you.`
    : `${MARKER}Stop repeating this call: ${tool} has now run ${calls} times this turn with the same input and the same result, and calling it again will not change that. Change your approach, or stop and explain what you need.`
}

/** The time limit for a tool in milliseconds, or undefined for none. A limit of 0 turns it off. */
export function timeoutFor(limits: Limits | undefined, tool: string) {
  const timeout = limits?.timeout
  if (timeout === undefined) return undefined
  if (typeof timeout === "number") return timeout > 0 && !TIMEOUT_EXEMPT.has(tool) ? timeout : undefined
  const own = timeout[tool]
  if (own !== undefined) return own > 0 ? own : undefined
  const all = timeout["*"]
  return all !== undefined && all > 0 && !TIMEOUT_EXEMPT.has(tool) ? all : undefined
}

export function timeoutMessage(tool: string, ms: number) {
  const seconds = ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`
  return `The ${tool} tool did not finish within ${seconds} and was stopped. Try a smaller request or a different approach.`
}

export * as ToolLimits from "./tool-limits"
