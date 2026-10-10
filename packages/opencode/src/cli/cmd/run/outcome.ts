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

const MAX_SCHEMA_SIZE = 65_536
const MAX_SCHEMA_DEPTH = 32

function validateSchemaSecurity(value: unknown, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error("--output-schema exceeds maximum nesting depth")
  }
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) {
      validateSchemaSecurity(item, depth + 1)
    }
    return
  }
  const obj = value as Record<string, unknown>
  for (const [key, val] of Object.entries(obj)) {
    if (key === "$ref" && typeof val === "string") {
      const ref = val.trim()
      if (
        ref.startsWith("http:") ||
        ref.startsWith("https:") ||
        ref.startsWith("file:") ||
        ref.startsWith("ftp:") ||
        ref.startsWith("//") ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)
      ) {
        throw new Error(`--output-schema must not contain remote or external $ref references ("${ref}")`)
      }
    }
    validateSchemaSecurity(val, depth + 1)
  }
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
  if (Buffer.byteLength(text, "utf-8") > MAX_SCHEMA_SIZE) {
    throw new Error("--output-schema is too large (maximum 64 KB)")
  }
  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch {
    throw new Error(inline ? "--output-schema is not valid JSON" : `--output-schema file ${value} is not valid JSON`)
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("--output-schema must be a JSON Schema object")
  validateSchemaSecurity(schema)
  return schema as Record<string, unknown>
}

export function dollars(value: number) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/** Commands the session handles itself, before looking one up in the command list. */
const SESSION_COMMANDS = new Set(["goal", "loop"])

/**
 * The message for `yukioshi run --command <name>` when no such command exists, or undefined when it does. The
 * server's own "Command not found" error is hidden behind a generic one, so the run checks first. Commands that
 * only exist in the terminal UI (such as /usage) are not slash commands of the server.
 */
export function unknownCommandMessage(name: string, available: readonly string[]): string | undefined {
  if (SESSION_COMMANDS.has(name) || available.includes(name)) return undefined
  const hint = available.length ? ` Available commands: ${[...available].sort().join(", ")}.` : ""
  return `Command not found: "${name}".${hint} Some slash commands, such as /usage, only exist in the terminal UI.`
}
