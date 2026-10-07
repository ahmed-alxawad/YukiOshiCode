// How a `yukioshi run` ended, as an exit code that scripts can rely on (docs/features.md, "Scripting with
// yukioshi run"), plus the helpers for --output-schema and goal outcomes.

import path from "path"
import type { SessionGoal } from "@/session/goal"

export const EXIT = {
  /** Finished, and a goal worked on in this run is done. */
  ok: 0,
  /** An error: the model or provider failed, or the answer did not match --output-schema. */
  error: 1,
  /** A goal stopped because it needs you: the check asked for a decision or access, or a permission was refused. */
  goalBlocked: 3,
  /** A goal paused after using all its rounds (goal.max_rounds); `/goal resume` continues it. */
  goalRounds: 4,
  /** Stopped at --max-turns. */
  maxTurns: 5,
  /** Stopped by a spending limit: --max-cost or the budget setting. */
  spending: 6,
} as const

/** The exit code for a goal that paused during this run (since `since`), or undefined. */
export function goalExitCode(
  goal: Pick<SessionGoal.Goal, "status" | "paused" | "updated"> | undefined,
  since: number,
): number | undefined {
  if (!goal || goal.status !== "paused" || goal.updated < since) return undefined
  if (goal.paused === "rounds") return EXIT.goalRounds
  if (goal.paused === "blocked" || goal.paused === "refused") return EXIT.goalBlocked
  return undefined
}

/** Reads --output-schema: inline JSON when the value starts with "{", otherwise a file. */
export async function readOutputSchema(value: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const inline = value.trim().startsWith("{")
  const text = inline
    ? value
    : await Bun.file(path.resolve(cwd, value))
        .text()
        .catch(() => {
          throw new Error(`Cannot read the --output-schema file ${value}`)
        })
  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch {
    throw new Error(inline ? "--output-schema is not valid JSON" : `--output-schema file ${value} is not valid JSON`)
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("--output-schema must be a JSON Schema object")
  return schema as Record<string, unknown>
}

export function dollars(value: number) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}
