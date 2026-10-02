import type { Verification } from "@yukioshi/schema/verification"

export interface PlannedCheck {
  readonly kind: Verification.CheckKind
  readonly label: string
  /** Tool used to run it, or `internal` for in-process checks. */
  readonly tool: "internal" | "get_diagnostics" | "run_typecheck" | "run_lint" | "run_tests"
  readonly paths?: readonly string[]
}

export interface FileChangeInput {
  readonly path: string
  readonly kind?: "created" | "modified" | "deleted" | "moved" | string
}

export interface ProjectCommandInput {
  readonly kind: string
  readonly label: string
  readonly command?: string
  readonly args?: readonly string[]
}

/** Smallest meaningful sequence: syntax → diagnostics → typecheck → lint → tests. */
export function planVerification(
  changes: readonly FileChangeInput[],
  commands: readonly ProjectCommandInput[],
  diagnosticsAvailable: boolean,
): PlannedCheck[] {
  const touched = changes.filter((change) => change.kind !== "deleted").map((change) => change.path)
  const checks: PlannedCheck[] = []

  const json = touched.filter(
    (path) => /\.(json|jsonc)$/i.test(path) && !/tsconfig|jsconfig|\.vscode\//i.test(path),
  )
  if (json.length > 0) {
    checks.push({
      kind: "syntax",
      label: `JSON syntax (${json.length} file${json.length === 1 ? "" : "s"})`,
      tool: "internal",
      paths: json,
    })
  }

  if (diagnosticsAvailable && touched.length > 0) {
    checks.push({
      kind: "diagnostics",
      label: "Editor diagnostics",
      tool: "get_diagnostics",
      paths: touched,
    })
  }

  const find = (kind: string): ProjectCommandInput | undefined =>
    commands.find((command) => command.kind === kind)

  const typecheck = find("typecheck")
  if (typecheck) checks.push({ kind: "typecheck", label: typecheck.label, tool: "run_typecheck" })

  const lint = find("lint")
  if (lint) checks.push({ kind: "lint", label: lint.label, tool: "run_lint" })

  const test = find("test")
  if (test) checks.push({ kind: "test", label: test.label, tool: "run_tests" })

  return checks
}
