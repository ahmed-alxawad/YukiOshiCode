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
  readonly kind?: string
}

export interface ProjectCommandInput {
  readonly kind: string
  readonly label: string
  readonly command?: string
  readonly args?: readonly string[]
}

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".clj",
  ".cljc",
  ".cljs",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cxx",
  ".dart",
  ".ejs",
  ".el",
  ".erl",
  ".ex",
  ".exs",
  ".fish",
  ".fs",
  ".fsi",
  ".fsx",
  ".gql",
  ".go",
  ".graphql",
  ".groovy",
  ".h",
  ".hbs",
  ".hh",
  ".hpp",
  ".hrl",
  ".hs",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lhs",
  ".lua",
  ".m",
  ".mm",
  ".mjs",
  ".ml",
  ".mli",
  ".mts",
  ".njk",
  ".php",
  ".pl",
  ".pm",
  ".proto",
  ".ps1",
  ".py",
  ".pyi",
  ".r",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".zig",
  ".zsh",
])

const SOURCE_FILENAMES = new Set(["dockerfile", "makefile", "rakefile"])

function isSourcePath(filepath: string) {
  const normalized = filepath.replaceAll("\\", "/").toLowerCase()
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1)
  if (SOURCE_FILENAMES.has(filename)) return true
  const dot = filename.lastIndexOf(".")
  return dot >= 0 && SOURCE_EXTENSIONS.has(filename.slice(dot))
}

/** Smallest meaningful sequence: syntax → diagnostics → typecheck → lint → tests. */
export function planVerification(
  changes: readonly FileChangeInput[],
  commands: readonly ProjectCommandInput[],
  diagnosticsAvailable: boolean,
): PlannedCheck[] {
  const touched = changes.filter((change) => change.kind !== "deleted").map((change) => change.path)
  const checks: PlannedCheck[] = []

  const json = touched.filter((path) => /\.(json|jsonc)$/i.test(path) && !/tsconfig|jsconfig|\.vscode\//i.test(path))
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

  // Repository-wide commands are intentionally reserved for source edits. Documentation and
  // configuration-only changes still receive applicable in-process checks (for example JSON syntax)
  // and editor diagnostics, but do not pay the cost of a full typecheck/lint/test cycle.
  if (!changes.some((change) => isSourcePath(change.path))) return checks

  const find = (kind: string): ProjectCommandInput | undefined => commands.find((command) => command.kind === kind)

  const typecheck = find("typecheck")
  if (typecheck) checks.push({ kind: "typecheck", label: typecheck.label, tool: "run_typecheck" })

  const lint = find("lint")
  if (lint) checks.push({ kind: "lint", label: lint.label, tool: "run_lint" })

  const test = find("test")
  if (test) checks.push({ kind: "test", label: test.label, tool: "run_tests" })

  return checks
}
