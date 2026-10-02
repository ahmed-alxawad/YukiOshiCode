import type { Verification } from "@yukioshi/schema/verification"
import { Effect } from "effect"
import { planVerification, type FileChangeInput, type PlannedCheck, type ProjectCommandInput } from "./plan"
import { summarizeVerification } from "./result"

export interface ToolExecutionResult {
  readonly status: "success" | "failed" | "error" | "denied" | "cancelled"
  readonly output: string
  readonly exitCode?: number
  readonly durationMs: number
}

export interface DiagnosticItem {
  readonly path: string
  readonly line?: number
  readonly column?: number
  readonly message: string
  readonly severity?: "error" | "warning" | "info" | string
}

export interface VerificationDiagnostics {
  readonly available: boolean
  readonly get: () => Promise<readonly DiagnosticItem[]> | Effect.Effect<readonly DiagnosticItem[]>
}

export interface VerificationDependencies {
  /** Runs a tool through policy and execution runner. */
  readonly runTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult> | Effect.Effect<ToolExecutionResult>
  /** Reads a workspace file's current text for in-process syntax checks. */
  readonly readFile: (relativePath: string) => Promise<string | undefined> | Effect.Effect<string | undefined>
  readonly diagnostics?: VerificationDiagnostics
  readonly commands: readonly ProjectCommandInput[]
  readonly onCheck?: (check: Verification.Check) => void
  readonly onStart?: (labels: readonly string[]) => void
}

function evidenceOf(text: string, max = 3_000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`
}

async function unwrap<T>(value: Promise<T> | Effect.Effect<T>): Promise<T> {
  if (Effect.isEffect(value)) {
    return Effect.runPromise(value)
  }
  return value
}

/** Verification is evidence, not confidence: every status comes from an executed check. */
export class VerificationEngine {
  constructor(private readonly deps: VerificationDependencies) {}

  async verify(changes: readonly FileChangeInput[], signal?: AbortSignal): Promise<Verification.Summary> {
    const diagnosticsAvailable = this.deps.diagnostics?.available ?? false
    const planned = planVerification(changes, this.deps.commands, diagnosticsAvailable)

    this.deps.onStart?.(planned.map((check) => check.label))
    const checks: Verification.Check[] = []

    for (const check of planned) {
      if (signal?.aborted) {
        throw new Error("Verification cancelled")
      }
      const result = await this.run(check)
      checks.push(result)
      this.deps.onCheck?.(result)

      // Stop early on type errors: tests would fail for the same reason and cost time.
      if (result.kind === "typecheck" && (result.status === "failed" || result.status === "error")) {
        break
      }
    }

    return summarizeVerification(checks)
  }

  verifyEffect(
    changes: readonly FileChangeInput[],
    signal?: AbortSignal,
  ): Effect.Effect<Verification.Summary, Error> {
    return Effect.tryPromise({
      try: () => this.verify(changes, signal),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
  }

  private async run(check: PlannedCheck): Promise<Verification.Check> {
    const started = Date.now()

    if (check.tool === "internal") {
      const problems: string[] = []
      for (const path of check.paths ?? []) {
        const text = await unwrap(this.deps.readFile(path))
        if (text === undefined) continue
        try {
          JSON.parse(text.replace(/^\uFEFF/, ""))
        } catch (error) {
          problems.push(`${path}: ${(error as Error).message}`)
        }
      }
      return {
        kind: check.kind,
        label: check.label,
        status: problems.length > 0 ? "failed" : "passed",
        durationMs: Date.now() - started,
        evidence: problems.join("\n") || "All JSON files parse.",
      }
    }

    if (check.tool === "get_diagnostics") {
      const allDiagnostics = this.deps.diagnostics ? await unwrap(this.deps.diagnostics.get()) : []
      const diagnostics = allDiagnostics.filter(
        (d) => d.severity === "error" && (check.paths ?? []).includes(d.path),
      )
      return {
        kind: check.kind,
        label: check.label,
        status: diagnostics.length > 0 ? "failed" : "passed",
        durationMs: Date.now() - started,
        evidence:
          diagnostics.length > 0
            ? diagnostics
                .slice(0, 30)
                .map((d) => `${d.path}${d.line !== undefined ? `:${d.line}` : ""}${d.column !== undefined ? `:${d.column}` : ""} ${d.message}`)
                .join("\n")
            : "No error diagnostics in changed files.",
      }
    }

    const result = await unwrap(this.deps.runTool(check.tool, { reason: `Verify the change: ${check.label}` }))
    if (result.status === "cancelled") {
      throw new Error("Verification cancelled")
    }

    const status: Verification.CheckStatus =
      result.status === "success"
        ? "passed"
        : result.status === "denied"
          ? "skipped"
          : result.exitCode !== undefined && result.exitCode !== 0
            ? "failed"
            : result.status === "failed"
              ? "failed"
              : "error"

    return {
      kind: check.kind,
      label: check.label,
      status,
      command: check.label,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      durationMs: result.durationMs,
      evidence: evidenceOf(result.output),
    }
  }
}
