// Learning nudges (learning.nudges, off by default): after a long turn or one that fixed an error, the next
// turn gets one hidden reminder that the agent may save a lesson with memory_save / skill_save. It never saves
// anything itself and grants no permission; the agent decides and the usual prompts still apply.

import type { SessionV1 } from "@yukioshi/core/v1/session"

export const DEFAULT_MIN_TOOL_CALLS = 8
export const DEFAULT_EVERY_TURNS = 20

export const REMINDER =
  "<system-reminder>The previous turn was long or fixed an error. If it taught something reusable, you may save it: " +
  "memory_save for a durable project fact or correction, skill_save for a repeatable procedure. Save only if it is " +
  "genuinely reusable and not specific to this one task; otherwise ignore this note. Saving still follows the normal " +
  "permission rules.</system-reminder>"

/** The turn before the last user message: its tool calls, and whether a failing call was followed by a success. */
export function lastTurnStats(messages: SessionV1.WithParts[]) {
  const users = messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []))
  if (users.length < 2) return { calls: 0, fixedError: false }
  const slice = messages.slice(users[users.length - 2], users[users.length - 1])
  let calls = 0
  let failed = false
  let fixedError = false
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      calls++
      if (part.state.status === "error") failed = true
      else if (part.state.status === "completed" && failed) fixedError = true
    }
  }
  return { calls, fixedError }
}

const lastNudge = new Map<string, number>()

/** Returns the reminder text when this turn should carry one. Same turn keeps the nudge across its steps. */
export function nudge(input: {
  sessionID: string
  messages: SessionV1.WithParts[]
  enabled?: boolean
  /** memory_save or skill_save is available */
  tools?: boolean
  minToolCalls?: number
  everyTurns?: number
}) {
  if (input.enabled !== true || input.tools === false) return undefined
  const turn = input.messages.filter((m) => m.info.role === "user").length
  const last = lastNudge.get(input.sessionID)
  if (last === turn) return REMINDER
  const stats = lastTurnStats(input.messages)
  if (stats.calls < (input.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS) && !stats.fixedError) return undefined
  if (last !== undefined && turn - last < (input.everyTurns ?? DEFAULT_EVERY_TURNS)) return undefined
  lastNudge.set(input.sessionID, turn)
  return REMINDER
}

export function reset() {
  lastNudge.clear()
}

export * as SessionLearning from "./learning"
