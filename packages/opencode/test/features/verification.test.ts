import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverProjectCommands,
  planVerification,
  runVerificationPipeline,
  type FileChangeInput,
  type ProjectCommandInput,
} from "@yukioshi/core/verification"

describe("Features > Verification", () => {
  describe("environment command overrides", () => {
    it("overrides detected test command with YUKIOSHI_VERIFY_TEST_CMD", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-feat-verify-"))
      const orig = process.env.YUKIOSHI_VERIFY_TEST_CMD
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: { test: "npm test", lint: "eslint .", typecheck: "tsc" },
          }),
        )
        process.env.YUKIOSHI_VERIFY_TEST_CMD = "bun test --filter unit"
        const commands = await discoverProjectCommands(dir)
        const testCmd = commands.find((c) => c.kind === "test")
        expect(testCmd).toBeDefined()
        expect(testCmd?.label).toBe("bun test --filter unit")
        expect(testCmd?.command).toBe("bun")
        expect(testCmd?.args).toEqual(["test", "--filter", "unit"])
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_VERIFY_TEST_CMD = orig
        else delete process.env.YUKIOSHI_VERIFY_TEST_CMD
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("overrides detected typecheck command with YUKIOSHI_VERIFY_TYPECHECK_CMD", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-feat-verify-"))
      const orig = process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: { typecheck: "tsc --noEmit" },
          }),
        )
        process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD = "tsc -p tsconfig.build.json"
        const commands = await discoverProjectCommands(dir)
        const tcCmd = commands.find((c) => c.kind === "typecheck")
        expect(tcCmd).toBeDefined()
        expect(tcCmd?.label).toBe("tsc -p tsconfig.build.json")
        expect(tcCmd?.command).toBe("tsc")
        expect(tcCmd?.args).toEqual(["-p", "tsconfig.build.json"])
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD = orig
        else delete process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("overrides detected lint command with YUKIOSHI_VERIFY_LINT_CMD", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-feat-verify-"))
      const orig = process.env.YUKIOSHI_VERIFY_LINT_CMD
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: { lint: "eslint ." },
          }),
        )
        process.env.YUKIOSHI_VERIFY_LINT_CMD = "biome check src/"
        const commands = await discoverProjectCommands(dir)
        const lintCmd = commands.find((c) => c.kind === "lint")
        expect(lintCmd).toBeDefined()
        expect(lintCmd?.label).toBe("biome check src/")
        expect(lintCmd?.command).toBe("biome")
        expect(lintCmd?.args).toEqual(["check", "src/"])
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_VERIFY_LINT_CMD = orig
        else delete process.env.YUKIOSHI_VERIFY_LINT_CMD
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("overrides all commands with a single YUKIOSHI_VERIFY_COMMAND", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-feat-verify-"))
      const orig = process.env.YUKIOSHI_VERIFY_COMMAND
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: { test: "npm test", lint: "eslint .", typecheck: "tsc" },
          }),
        )
        process.env.YUKIOSHI_VERIFY_COMMAND = "sh -c './scripts/verify.sh'"
        const commands = await discoverProjectCommands(dir)
        expect(commands).toHaveLength(1)
        expect(commands[0].kind).toBe("test")
        expect(commands[0].label).toBe("sh -c './scripts/verify.sh'")
        expect(commands[0].command).toBe("sh")
        expect(commands[0].args).toEqual(["-c", "./scripts/verify.sh"])
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_VERIFY_COMMAND = orig
        else delete process.env.YUKIOSHI_VERIFY_COMMAND
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("YUKIOSHI_SKIP_VERIFY", () => {
    it("turns verification off when YUKIOSHI_SKIP_VERIFY=1", async () => {
      const orig = process.env.YUKIOSHI_SKIP_VERIFY
      try {
        process.env.YUKIOSHI_SKIP_VERIFY = "1"
        const summary = await runVerificationPipeline({
          client: {},
          cwd: process.cwd(),
          sessionID: "test-session-skip",
        })
        expect(summary.status).toBe("SKIPPED_BY_USER")
        expect(summary.checks).toEqual([])
        expect(summary.explanation).toBe("Verification was skipped at your request.")
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_SKIP_VERIFY = orig
        else delete process.env.YUKIOSHI_SKIP_VERIFY
      }
    })
  })

  describe("change scope detection (docs/config vs source)", () => {
    const projectCommands: ProjectCommandInput[] = [
      { kind: "typecheck", label: "tsc --noEmit", command: "tsc", args: ["--noEmit"] },
      { kind: "lint", label: "eslint .", command: "eslint", args: ["."] },
      { kind: "test", label: "vitest run", command: "vitest", args: ["run"] },
    ]

    it("runs only lightweight checks (JSON syntax / diagnostics) for docs and config-only edits", () => {
      const docsAndConfigChanges: FileChangeInput[] = [
        { path: "README.md", kind: "modified" },
        { path: "docs/architecture.md", kind: "modified" },
        { path: "config.json", kind: "modified" },
      ]

      const plan = planVerification(docsAndConfigChanges, projectCommands, true)
      const kinds = plan.map((c) => c.kind)

      // Must include lightweight checks
      expect(kinds).toContain("syntax")
      expect(kinds).toContain("diagnostics")

      // Must NOT include full heavyweight project commands (typecheck, lint, test)
      expect(kinds).not.toContain("typecheck")
      expect(kinds).not.toContain("lint")
      expect(kinds).not.toContain("test")
    })

    it("plans full verification (typecheck, lint, test) when source files are changed", () => {
      const sourceChanges: FileChangeInput[] = [
        { path: "src/index.ts", kind: "modified" },
        { path: "README.md", kind: "modified" },
      ]

      const plan = planVerification(sourceChanges, projectCommands, true)
      const kinds = plan.map((c) => c.kind)

      expect(kinds).toContain("diagnostics")
      expect(kinds).toContain("typecheck")
      expect(kinds).toContain("lint")
      expect(kinds).toContain("test")
    })
  })
})
