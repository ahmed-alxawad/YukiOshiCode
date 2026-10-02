import { describe, expect, it } from "bun:test"
import { Verification } from "@yukioshi/schema/verification"
import {
  decideCompletion,
  noChangesVerification,
  planVerification,
  summarizeVerification,
  VerificationEngine,
  type PlannedCheck,
  type ProjectCommandInput,
  type ToolExecutionResult,
} from "../src/verification"
import { Effect } from "effect"

describe("Verification status and results", () => {
  const check = (
    kind: Verification.CheckKind,
    status: Verification.CheckStatus,
    label: string = kind,
    evidence: string = "",
  ): Verification.Check => ({
    kind,
    label,
    status,
    durationMs: 10,
    evidence,
  })

  it("handles no changes verification", () => {
    const summary = noChangesVerification()
    expect(summary.status).toBe("UNAVAILABLE")
    expect(summary.checks).toEqual([])
    expect(summary.explanation).toBe("No files were changed, so there was nothing to verify.")
  })

  it("returns UNAVAILABLE when no checks were executed and none skipped", () => {
    const summary = summarizeVerification([])
    expect(summary.status).toBe("UNAVAILABLE")
    expect(summary.checks).toEqual([])
    expect(summary.explanation).toBe("No test, lint, or type-check command was found for this project.")
  })

  it("returns SKIPPED_BY_USER when explicitly requested or all checks were declined", () => {
    const explicit = summarizeVerification([], true)
    expect(explicit.status).toBe("SKIPPED_BY_USER")
    expect(explicit.explanation).toBe("Verification was skipped at your request.")

    const allDeclined = summarizeVerification([check("test", "skipped", "Run tests")])
    expect(allDeclined.status).toBe("SKIPPED_BY_USER")
    expect(allDeclined.explanation).toBe("All checks were declined.")
  })

  it("returns FAILED when any check fails or errors", () => {
    const failedCheck = summarizeVerification([
      check("typecheck", "passed"),
      check("test", "failed", "Run unit tests"),
    ])
    expect(failedCheck.status).toBe("FAILED")
    expect(failedCheck.explanation).toBe("Run unit tests failed.")

    const errorCheck = summarizeVerification([
      check("lint", "error", "ESLint"),
      check("test", "passed"),
    ])
    expect(errorCheck.status).toBe("FAILED")
    expect(errorCheck.explanation).toBe("ESLint failed.")

    const multipleFailed = summarizeVerification([
      check("typecheck", "failed", "TypeScript check"),
      check("test", "failed", "Unit tests"),
    ])
    expect(multipleFailed.status).toBe("FAILED")
    expect(multipleFailed.explanation).toBe("TypeScript check, Unit tests failed.")
  })

  it("returns VERIFIED when behavioral checks pass and no checks are skipped or failed", () => {
    const summary = summarizeVerification([
      check("syntax", "passed", "JSON syntax"),
      check("typecheck", "passed", "Type check"),
      check("lint", "passed", "Linter"),
      check("test", "passed", "Test suite"),
    ])
    expect(summary.status).toBe("VERIFIED")
    expect(summary.explanation).toBe("JSON syntax, Type check, Linter, Test suite passed.")
  })

  it("returns PARTIALLY_VERIFIED when only static checks pass", () => {
    const summary = summarizeVerification([
      check("syntax", "passed", "JSON syntax"),
      check("typecheck", "passed", "Type check"),
    ])
    expect(summary.status).toBe("PARTIALLY_VERIFIED")
    expect(summary.explanation).toBe("JSON syntax, Type check passed; no tests were run.")
  })

  it("returns PARTIALLY_VERIFIED when tests pass but some checks were skipped", () => {
    const summary = summarizeVerification([
      check("test", "passed", "Test suite"),
      check("lint", "skipped", "Linter"),
    ])
    expect(summary.status).toBe("PARTIALLY_VERIFIED")
    expect(summary.explanation).toBe("Test suite passed; Linter not run.")
  })
})

describe("Verification planning", () => {
  it("plans syntax check for JSON and JSONC files but excludes tsconfig/jsconfig/.vscode", () => {
    const changes = [
      { path: "src/data.json", kind: "modified" },
      { path: "config/schema.jsonc", kind: "created" },
      { path: "tsconfig.json", kind: "modified" },
      { path: ".vscode/settings.json", kind: "modified" },
      { path: "src/deleted.json", kind: "deleted" },
    ]
    const planned = planVerification(changes, [], false)
    expect(planned.length).toBe(1)
    expect(planned[0]?.kind).toBe("syntax")
    expect(planned[0]?.tool).toBe("internal")
    expect(planned[0]?.paths).toEqual(["src/data.json", "config/schema.jsonc"])
  })

  it("plans diagnostics when diagnostics are available and files were changed", () => {
    const changes = [{ path: "src/index.ts", kind: "modified" }]
    const plannedWithDiagnostics = planVerification(changes, [], true)
    expect(plannedWithDiagnostics.some((c) => c.kind === "diagnostics" && c.tool === "get_diagnostics")).toBe(true)

    const plannedWithoutDiagnostics = planVerification(changes, [], false)
    expect(plannedWithoutDiagnostics.some((c) => c.kind === "diagnostics")).toBe(false)

    const plannedNoChanges = planVerification([], [], true)
    expect(plannedNoChanges.length).toBe(0)
  })

  it("plans project commands in strict canonical order: typecheck → lint → test", () => {
    const commands: ProjectCommandInput[] = [
      { kind: "test", label: "bun test" },
      { kind: "typecheck", label: "tsc --noEmit" },
      { kind: "lint", label: "eslint" },
    ]
    const planned = planVerification([{ path: "src/main.ts", kind: "modified" }], commands, false)
    const kinds = planned.map((c) => c.kind)
    expect(kinds).toEqual(["typecheck", "lint", "test"])
  })
})

describe("VerificationEngine execution", () => {
  it("executes in-process JSON syntax check and handles BOM", async () => {
    const files: Record<string, string> = {
      "valid.json": '{"name": "test"}',
      "bom.json": '\uFEFF{"name": "bom"}',
      "invalid.json": '{"bad": invalid}',
    }

    const engine = new VerificationEngine({
      runTool: async () => ({ status: "success", output: "", durationMs: 5 }),
      readFile: async (path) => files[path],
      commands: [],
    })

    const passSummary = await engine.verify([{ path: "valid.json", kind: "modified" }, { path: "bom.json", kind: "modified" }])
    expect(passSummary.status).toBe("PARTIALLY_VERIFIED")
    expect(passSummary.checks[0]?.status).toBe("passed")
    expect(passSummary.checks[0]?.evidence).toBe("All JSON files parse.")

    const failSummary = await engine.verify([{ path: "invalid.json", kind: "modified" }])
    expect(failSummary.status).toBe("FAILED")
    expect(failSummary.checks[0]?.status).toBe("failed")
    expect(failSummary.checks[0]?.evidence).toContain("invalid.json:")
  })

  it("executes diagnostics check and filters to error severity on touched paths", async () => {
    const engine = new VerificationEngine({
      runTool: async () => ({ status: "success", output: "", durationMs: 5 }),
      readFile: async () => undefined,
      diagnostics: {
        available: true,
        get: async () => [
          { path: "src/a.ts", line: 10, column: 5, message: "Type mismatch", severity: "error" },
          { path: "src/a.ts", line: 12, column: 1, message: "Unused variable", severity: "warning" },
          { path: "src/untouched.ts", line: 1, column: 1, message: "Unrelated error", severity: "error" },
        ],
      },
      commands: [],
    })

    const summary = await engine.verify([{ path: "src/a.ts", kind: "modified" }])
    expect(summary.status).toBe("FAILED")
    expect(summary.checks[0]?.kind).toBe("diagnostics")
    expect(summary.checks[0]?.status).toBe("failed")
    expect(summary.checks[0]?.evidence).toContain("src/a.ts:10:5 Type mismatch")
    expect(summary.checks[0]?.evidence).not.toContain("Unused variable")
    expect(summary.checks[0]?.evidence).not.toContain("src/untouched.ts")
  })

  it("maps tool results accurately including exitCode, status, and evidence truncation", async () => {
    const longOutput = "x".repeat(4000)
    const engine = new VerificationEngine({
      runTool: async (tool) => {
        if (tool === "run_typecheck") {
          return { status: "success", output: "Typecheck OK", durationMs: 50, exitCode: 0 }
        }
        if (tool === "run_lint") {
          return { status: "denied", output: "Denied by policy", durationMs: 5 }
        }
        if (tool === "run_tests") {
          return { status: "success", output: longOutput, durationMs: 120, exitCode: 0 }
        }
        return { status: "error", output: "Unknown tool", durationMs: 1 }
      },
      readFile: async () => undefined,
      commands: [
        { kind: "typecheck", label: "tsc" },
        { kind: "lint", label: "eslint" },
        { kind: "test", label: "vitest" },
      ],
    })

    const summary = await engine.verify([{ path: "src/app.ts", kind: "modified" }])
    expect(summary.checks.length).toBe(3)
    expect(summary.checks[0]?.status).toBe("passed")
    expect(summary.checks[1]?.status).toBe("skipped")
    expect(summary.checks[2]?.status).toBe("passed")
    expect(summary.checks[2]?.evidence.length).toBe(3001) // "…" + 3000 chars
    expect(summary.checks[2]?.evidence.startsWith("…")).toBe(true)
    expect(summary.status).toBe("PARTIALLY_VERIFIED")
  })

  it("stops early on typecheck failure to avoid running doomed tests", async () => {
    let testRan = false
    const engine = new VerificationEngine({
      runTool: async (tool) => {
        if (tool === "run_typecheck") {
          return { status: "failed", output: "TS2322: Type error", exitCode: 1, durationMs: 40 }
        }
        if (tool === "run_tests") {
          testRan = true
          return { status: "success", output: "PASS", exitCode: 0, durationMs: 100 }
        }
        return { status: "success", output: "", durationMs: 1 }
      },
      readFile: async () => undefined,
      commands: [
        { kind: "typecheck", label: "tsc" },
        { kind: "test", label: "bun test" },
      ],
    })

    const summary = await engine.verify([{ path: "src/file.ts", kind: "modified" }])
    expect(summary.status).toBe("FAILED")
    expect(summary.checks.length).toBe(1)
    expect(summary.checks[0]?.kind).toBe("typecheck")
    expect(testRan).toBe(false)
  })

  it("supports Effect-TS via verifyEffect", async () => {
    const engine = new VerificationEngine({
      runTool: (tool) =>
        Effect.succeed<ToolExecutionResult>({
          status: "success",
          output: `${tool} passed`,
          durationMs: 20,
          exitCode: 0,
        }),
      readFile: () => Effect.succeed(undefined),
      commands: [{ kind: "test", label: "bun test" }],
    })

    const program = engine.verifyEffect([{ path: "src/code.ts", kind: "modified" }])
    const summary = await Effect.runPromise(program)
    expect(summary.status).toBe("VERIFIED")
    expect(summary.checks.length).toBe(1)
    expect(summary.checks[0]?.status).toBe("passed")
  })

  it("handles cancellation signal gracefully", async () => {
    const controller = new AbortController()
    controller.abort()

    const engine = new VerificationEngine({
      runTool: async () => ({ status: "success", output: "", durationMs: 1 }),
      readFile: async () => undefined,
      commands: [{ kind: "test", label: "bun test" }],
    })

    expect(engine.verify([{ path: "src/x.ts", kind: "modified" }], controller.signal)).rejects.toThrow(
      "Verification cancelled",
    )
  })
})

describe("Completion Policy (decideCompletion)", () => {
  it("finishes when verification preference is explicitly 'skip'", () => {
    expect(
      decideCompletion({
        mode: "agent",
        needsVerification: true,
        changesCount: 2,
        verificationPreference: "skip",
      }),
    ).toBe("finish")
  })

  it("finishes when no files were changed", () => {
    expect(
      decideCompletion({
        mode: "agent",
        needsVerification: true,
        changesCount: 0,
      }),
    ).toBe("finish")
  })

  it("triggers verification when changes exist and needsVerification is true", () => {
    expect(
      decideCompletion({
        mode: "agent",
        needsVerification: true,
        changesCount: 1,
      }),
    ).toBe("verify")

    expect(
      decideCompletion({
        mode: "edit",
        needsVerification: true,
        changesCount: 3,
      }),
    ).toBe("verify")

    expect(
      decideCompletion({
        mode: "auto",
        needsVerification: true,
        changesCount: 2,
      }),
    ).toBe("verify")
  })

  it("finishes when needsVerification is false", () => {
    expect(
      decideCompletion({
        mode: "agent",
        needsVerification: false,
        changesCount: 2,
      }),
    ).toBe("finish")
  })
})
