import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import {
  discoverProjectCommands,
  detectTurnChangedFiles,
  executeVerificationCommand,
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

    it("preserves quoted arguments in environment command overrides", async () => {
      const original = process.env.YUKIOSHI_VERIFY_COMMAND
      try {
        process.env.YUKIOSHI_VERIFY_COMMAND = 'node -e "process.stdout.write(\\"hello world\\")"'
        const [command] = await discoverProjectCommands("/nonexistent-dir")
        expect(command.command).toBe("node")
        expect(command.args).toEqual(["-e", 'process.stdout.write("hello world")'])

        const result = await executeVerificationCommand(command, process.cwd(), 2_000)
        expect(result.status).toBe("success")
        expect(result.output).toBe("hello world")
      } finally {
        if (original !== undefined) process.env.YUKIOSHI_VERIFY_COMMAND = original
        else delete process.env.YUKIOSHI_VERIFY_COMMAND
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

    it("does not attribute historical messages or dirty worktree files to a concrete no-edit turn", async () => {
      let messagesCalled = false
      const mockClient: any = {
        session: {
          diff: () => Promise.resolve({ data: [] }),
          messages: () => {
            messagesCalled = true
            return Promise.resolve({
              data: [{ info: { id: "old", summary: { diffs: [{ file: "old-change.ts" }] } }, parts: [] }],
            })
          },
        },
      }
      const promptResult = { data: { info: { id: "current", parentID: "user-current" }, parts: [] } }

      expect(await detectTurnChangedFiles(mockClient, "ses-1", promptResult, process.cwd())).toEqual([])
      expect(messagesCalled).toBe(true)
    })

    it("detects a patch from an earlier assistant step in the current turn", async () => {
      const mockClient: any = {
        session: {
          diff: () => Promise.resolve({ data: [] }),
          messages: () =>
            Promise.resolve({
              data: [
                { info: { id: "user-current", role: "user", summary: { diffs: [] } }, parts: [] },
                {
                  info: { id: "assistant-tool", role: "assistant", parentID: "user-current" },
                  parts: [
                    { type: "tool", tool: "bash", state: { status: "completed", input: { command: "write" } } },
                    { type: "patch", files: ["app-config.json"] },
                  ],
                },
                {
                  info: { id: "assistant-current", role: "assistant", parentID: "user-current" },
                  parts: [{ type: "text", text: "done" }],
                },
                { info: { id: "old", role: "user", summary: { diffs: [{ file: "old-change.ts" }] } }, parts: [] },
              ],
            }),
        },
      }

      const changes = await detectTurnChangedFiles(mockClient, "ses-1", {
        data: {
          info: { id: "assistant-current", role: "assistant", parentID: "user-current" },
          parts: [{ type: "text", text: "done" }],
        },
      })

      expect(changes).toEqual([{ path: "app-config.json", kind: "modified" }])
    })

    it("recognizes the TUI assistant-message shape when requesting the turn diff", async () => {
      let input: unknown
      const mockClient: any = {
        session: {
          diff: (value: unknown) => {
            input = value
            return Promise.resolve({ data: [{ file: "src/tui-change.ts" }] })
          },
        },
      }

      const changes = await detectTurnChangedFiles(mockClient, "ses-1", {
        id: "assistant-current",
        parentID: "user-current",
      })
      expect(input).toEqual({ sessionID: "ses-1", messageID: "user-current" })
      expect(changes).toEqual([{ path: "src/tui-change.ts", kind: "modified" }])
    })

    it("limits message fallback to the newest message when no turn result is available", async () => {
      let request: unknown
      const mockClient: any = {
        session: {
          messages: (input: unknown) => {
            request = input
            return Promise.resolve({
              data: [
                { info: { id: "latest", summary: { diffs: [{ file: "latest.ts" }] } }, parts: [] },
                { info: { id: "old", summary: { diffs: [{ file: "old.ts" }] } }, parts: [] },
              ],
            })
          },
        },
      }

      const changes = await detectTurnChangedFiles(mockClient, "ses-1", undefined, process.cwd())
      expect(request).toEqual({ sessionID: "ses-1", limit: 1 })
      expect(changes).toEqual([{ path: "latest.ts", kind: "modified" }])
    })
  })

  describe("executeVerificationCommand", () => {
    it("kills descendant workers before returning a timeout", async () => {
      const dir = mkdtempSync(join(tmpdir(), "yk-verify-tree-"))
      const marker = join(dir, "descendant-survived")
      try {
        const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 700)`
        const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`
        const result = await executeVerificationCommand(
          {
            kind: "test",
            label: "process-tree timeout probe",
            command: process.execPath,
            args: ["-e", parentCode],
          },
          dir,
          120,
        )

        expect(result.exitCode).toBe(124)
        await Bun.sleep(700)
        expect(existsSync(marker)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
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
        writeFileSync(join(dir, "file.ts"), "export const hello = 1\n")
        const output: string[] = []
        const mockClient: any = { session: {} }

        const summary = await executePostTurnVerification({
          cwd: dir,
          client: mockClient,
          sessionID: "ses-1",
          changedFilesOverride: [{ path: "file.ts", kind: "modified" }],
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
          reply()
            .text("starting")
            .tool("bash", {
              command: `printf '%s\\n' 'export const version = "1.0"' > ${JSON.stringify(join(home, "version.ts"))}`,
              description: "Create version.ts",
            }),
        )
        yield* llm.text("Created version.ts")

        const result = yield* opencode.run("create the version file", {
          extraArgs: ["--dangerously-skip-permissions", "--verify"],
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
        expect(result.stdout).toContain("Created version.ts")
        // Verify that verification was executed and printed matching main's UX
        expect(result.stdout).toMatch(/Verification: VERIFIED/)
      }),
    60_000,
  )
})
