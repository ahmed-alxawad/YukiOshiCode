export * as RiskClassifier from "./risk"

/**
 * Coarse risk classification used by permission mode "auto": only
 * low-risk actions are auto-resolved from "ask" to "allow". Everything
 * else keeps asking, same as "manual", until the user explicitly grants
 * it (a rule, a saved approval, or switching to "auto-all").
 */

export type Level = "low" | "medium" | "high"

const LOW: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "todoread",
  "todowrite",
  "question",
  "memory_recall",
  "code_search",
  "code_graph",
  "session_search",
])
const MEDIUM: ReadonlySet<string> = new Set(["webfetch", "websearch", "external_directory"])
const HIGH: ReadonlySet<string> = new Set(["bash", "edit", "write", "apply_patch", "memory_save", "skill_save", "delegate"])

export function classify(action: string): Level {
  if (LOW.has(action)) return "low"
  if (MEDIUM.has(action)) return "medium"
  if (HIGH.has(action)) return "high"
  // Unknown/unrecognized tool actions default to high risk: never
  // auto-allow a tool this classifier hasn't been told about.
  return "high"
}
