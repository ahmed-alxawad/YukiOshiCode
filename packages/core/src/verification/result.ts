import type { Verification } from "@yukioshi/schema/verification"

/**
 * Derives the overall status from observed checks only:
 * - FAILED: any check failed or errored;
 * - VERIFIED: no failures and a behavioral check (tests) passed;
 * - PARTIALLY_VERIFIED: only static checks passed, or some checks were skipped;
 * - UNAVAILABLE: nothing could be run;
 * - SKIPPED_BY_USER: the user declined verification.
 */
export function summarizeVerification(
  checks: readonly Verification.Check[],
  skippedByUser = false,
): Verification.Summary {
  if (skippedByUser) {
    return {
      status: "SKIPPED_BY_USER",
      checks: [...checks],
      explanation: "Verification was skipped at your request.",
    }
  }

  const executed = checks.filter(
    (check) => check.status === "passed" || check.status === "failed" || check.status === "error",
  )
  const failed = checks.filter((check) => check.status === "failed" || check.status === "error")
  const skipped = checks.filter((check) => check.status === "skipped")

  let status: Verification.Status
  let explanation: string

  if (failed.length > 0) {
    status = "FAILED"
    explanation = `${failed.map((check) => check.label).join(", ")} failed.`
  } else if (executed.length === 0) {
    status = skipped.length > 0 ? "SKIPPED_BY_USER" : "UNAVAILABLE"
    explanation =
      skipped.length > 0
        ? "All checks were declined."
        : "No test, lint, or type-check command was found for this project."
  } else if (checks.some((check) => check.kind === "test" && check.status === "passed") && skipped.length === 0) {
    status = "VERIFIED"
    explanation = `${executed.map((check) => check.label).join(", ")} passed.`
  } else {
    status = "PARTIALLY_VERIFIED"
    explanation = `${executed.map((check) => check.label).join(", ")} passed${
      skipped.length > 0 ? `; ${skipped.map((check) => check.label).join(", ")} not run` : "; no tests were run"
    }.`
  }

  return { status, checks: [...checks], explanation }
}

export function noChangesVerification(): Verification.Summary {
  return {
    status: "UNAVAILABLE",
    checks: [],
    explanation: "No files were changed, so there was nothing to verify.",
  }
}
