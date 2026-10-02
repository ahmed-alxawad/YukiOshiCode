import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import {
  discoverProjectCommands,
  detectTurnChangedFiles,
  executePostTurnVerification,
  formatVerificationOutput,
} from "../../src/cli/cmd/run/verification"

describe("run verification post-turn", () => {
  describe("discoverProjectCommands", () => {
    it("discovers test, lint, and typecheck from package.json", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-cmd-test-"))
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: {
              test: "vitest run",
              lint: "eslint .",
              typecheck: "tsc --noEmit",
            },
          }),
        )
        const commands = await discoverProjectCommands(dir)
        expect(commands.find((c) => c.kind === "test")).toBeDefined()
        expect(commands.find((c) => c.kind === "lint")).toBeDefined()
        expect(commands.find((c) => c.kind === "typecheck")).toBeDefined()
        expect(commands.find((c) => c.kind === "test")?.label).toContain("test")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("respects environment command overrides", async () => {
      const orig = process.env.YUKIOSHI_VERIFY_TEST_CMD
      try {
        process.env.YUKIOSHI_VERIFY_TEST_CMD = "custom-test-runner --suite unit"
        const commands = await discoverProjectCommands("/nonexistent-dir")
        const testCmd = commands.find((c) => c.kind === "test")
        expect(testCmd).toBeDefined()
        expect(testCmd?.command).toBe("custom-test-runner")
        expect(testCmd?.args).toEqual(["--suite", "unit"])
      } finally {
        if (orig !== undefined) process.env.YUKIOSHI_VERIFY_TEST_CMD = orig
        else delete process.env.YUKIOSHI_VERIFY_TEST_CMD
      }
    })
  })

  describe("detectTurnChangedFiles", () => {
    it("detects files from session.diff and patch parts", async () => {
      const mockClient: any = {
        session: {
          diff: () => Promise.resolve({ data: [{ file: "src/user.ts" }] }),
        },
      }
      const promptResult = {
        data: {
          info: { parentID: "msg-user-1" },
          parts: [
            { type: "patch", files: ["src/user.ts", "package.json"] },
            {
              type: "tool",
              tool: "write",
              state: { status: "completed", input: { filePath: "src/config.json" } },
            },
          ],
        },
      }

      const changes = await detectTurnChangedFiles(mockClient, "ses-1", promptResult)
      const paths = changes.map((c) => c.path)
      expect(paths).toContain("src/user.ts")
      expect(paths).toContain("package.json")
      expect(paths).toContain("src/config.json")
    })
  })

  describe("executePostTurnVerification unit execution", () => {
    it("reports UNAVAILABLE when no files were changed", async () => {
      const output: string[] = []
      const mockClient: any = { session: {} }
      const summary = await executePostTurnVerification({
        cwd: "/tmp",
        client: mockClient,
        sessionID: "ses-1",
        changedFilesOverride: [],
        out: (line) => output.push(line),
        isTTY: false,
      })

      expect(summary.status).toBe("UNAVAILABLE")
      expect(summary.explanation).toContain("No files were changed")
      expect(output.some((line) => line.includes("Verification: UNAVAILABLE"))).toBe(true)
    })

    it("reports SKIPPED_BY_USER when skip is set", async () => {
      const output: string[] = []
      const mockClient: any = { session: {} }
      const summary = await executePostTurnVerification({
        cwd: "/tmp",
        client: mockClient,
        sessionID: "ses-1",
        changedFilesOverride: [{ path: "app.json", kind: "modified" }],
        skip: true,
        out: (line) => output.push(line),
        isTTY: false,
      })

      expect(summary.status).toBe("SKIPPED_BY_USER")
      expect(output.some((line) => line.includes("Verification: SKIPPED_BY_USER"))).toBe(true)
    })

    it("verifies JSON syntax on changed json files and derives status", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-verify-json-"))
      try {
        writeFileSync(join(dir, "valid.json"), JSON.stringify({ ok: true, name: "test" }, null, 2))
        const output: string[] = []
        const mockClient: any = { session: {} }

        const summary = await executePostTurnVerification({
          cwd: dir,
          client: mockClient,
          sessionID: "ses-1",
          changedFilesOverride: [{ path: "valid.json", kind: "modified" }],
          commandsOverride: [], // no project tests configured
          out: (line) => output.push(line),
          isTTY: false,
        })

        // Since only static JSON check passed and no tests ran, status is PARTIALLY_VERIFIED
        expect(summary.status).toBe("PARTIALLY_VERIFIED")
        expect(summary.checks.length).toBe(1)
        expect(summary.checks[0].kind).toBe("syntax")
        expect(summary.checks[0].status).toBe("passed")
        expect(output.some((line) => line.includes("Verifying: JSON syntax (1 file)"))).toBe(true)
        expect(output.some((line) => line.includes("Verification: PARTIALLY_VERIFIED"))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("derives FAILED when JSON syntax check fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-verify-json-fail-"))
      try {
        writeFileSync(join(dir, "broken.json"), "{ invalid: json, trailing, }")
        const output: string[] = []
        const mockClient: any = { session: {} }

        const summary = await executePostTurnVerification({
          cwd: dir,
          client: mockClient,
          sessionID: "ses-1",
          changedFilesOverride: [{ path: "broken.json", kind: "modified" }],
          commandsOverride: [],
          out: (line) => output.push(line),
          isTTY: false,
        })

        expect(summary.status).toBe("FAILED")
        expect(summary.checks[0].status).toBe("failed")
        expect(output.some((line) => line.includes("Verification: FAILED"))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("derives VERIFIED when behavioral test check passes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-verify-test-pass-"))
      try {
        writeFileSync(join(dir, "file.txt"), "hello")
        const output: string[] = []
        const mockClient: any = { session: {} }

        const summary = await executePostTurnVerification({
          cwd: dir,
          client: mockClient,
          sessionID: "ses-1",
          changedFilesOverride: [{ path: "file.txt", kind: "modified" }],
          commandsOverride: [
            {
              kind: "test",
              label: "unit-tests",
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
            },
          ],
          out: (line) => output.push(line),
          isTTY: false,
        })

        expect(summary.status).toBe("VERIFIED")
        expect(summary.checks.length).toBe(1)
        expect(summary.checks[0].kind).toBe("test")
        expect(summary.checks[0].status).toBe("passed")
        expect(output.some((line) => line.includes("Verification: VERIFIED"))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("formatVerificationOutput", () => {
    it("formats TTY and non-TTY strings matching main UX", () => {
      const summary = {
        status: "VERIFIED" as const,
        checks: [],
        explanation: "All checks passed.",
      }
      const plain = formatVerificationOutput(summary, false)
      expect(plain).toBe("Verification: VERIFIED — All checks passed.")

      const tty = formatVerificationOutput(summary, true)
      expect(tty).toContain("Verification:")
      expect(tty).toContain("VERIFIED")
      expect(tty).toContain("All checks passed.")
    })
  })

  // Full round-trip integration test with opencode.run and TestLLMServer
  cliIt.live(
    "full round-trip: opencode run with tool-modifying turn prints verification status to stdout",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const { execSync } = yield* Effect.promise(() => import("node:child_process"))
        execSync("git init && git config user.email 'test@test.com' && git config user.name 'test'", { cwd: home })

        // Setup a project package.json with a test script that exits 0
        writeFileSync(
          join(home, "package.json"),
          JSON.stringify({
            name: "test-proj",
            scripts: {
              test: "node -e 'process.exit(0)'",
            },
          }),
        )
        execSync("git add . && git commit -m 'init'", { cwd: home })

        // Have the LLM call the bash tool to create/modify a file, then reply
        yield* llm.push(
          reply().text("starting").tool("bash", {
            command: "echo '{\"version\":\"1.0\"}' > app-config.json",
            description: "Create app-config.json",
          }),
        )
        yield* llm.text("Created app-config.json")

        const result = yield* opencode.run("create the config file", {
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            HTTP_PROXY: "",
            http_proxy: "",
            HTTPS_PROXY: "",
            https_proxy: "",
            NO_PROXY: "*",
            no_proxy: "*",
            YUKIOSHI_VERIFY_COMMAND: "node -e process.exit(0)",
          },
        })

        opencode.expectExit(result, 0)
        // Verify that the turn response was output
        expect(result.stdout).toContain("Created app-config.json")
        // Verify that verification was executed and printed matching main's UX
        expect(result.stdout).toMatch(/Verification: VERIFIED/)
      }),
    60_000,
  )
})
