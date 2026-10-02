export type CompletionDecision = "verify" | "finish"

export interface DecideCompletionInput {
  readonly mode?: string
  readonly needsVerification?: boolean
  readonly changesCount?: number
  readonly verificationPreference?: "run" | "skip" | "auto"
}

/** When the model stops calling tools: verify pending changes, or finish. */
export function decideCompletion(input: DecideCompletionInput): CompletionDecision {
  if (input.verificationPreference === "skip") return "finish"
  if (input.changesCount === 0) return "finish"
  if (
    (input.mode === "edit" ||
      input.mode === "agent" ||
      input.mode === "auto" ||
      input.mode === "auto-all" ||
      input.mode === undefined) &&
    input.needsVerification
  ) {
    return "verify"
  }
  return "finish"
}
