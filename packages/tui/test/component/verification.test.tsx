/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, type JSX } from "solid-js"
import {
  VerificationBadge,
  getVerificationColor,
  type TurnVerificationState,
} from "../../src/component/verification"
import {
  runVerificationPipeline,
  type VerificationClient,
} from "@yukioshi/core/verification"
import { type Theme, DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { RGBA } from "@opentui/core"
import { TestTuiContexts } from "../fixture/tui-environment"

const mockTheme: Theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")

function withTestTheme(component: () => JSX.Element) {
  return <TestTuiContexts>{component()}</TestTuiContexts>
}

async function renderFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return app.captureCharFrame()
}

describe("TUI verification integration", () => {
  describe("getVerificationColor", () => {
    test("maps statuses to theme colors matching main UX", () => {
      expect(getVerificationColor("VERIFIED", mockTheme)).toBe(mockTheme.success)
      expect(getVerificationColor("FAILED", mockTheme)).toBe(mockTheme.error)
      expect(getVerificationColor("PARTIALLY_VERIFIED", mockTheme)).toBe(mockTheme.warning)
      expect(getVerificationColor("SKIPPED_BY_USER", mockTheme)).toBe(mockTheme.textMuted)
      expect(getVerificationColor("UNAVAILABLE", mockTheme)).toBe(mockTheme.textMuted)
    })
  })

  describe("VerificationBadge component", () => {
    test("renders nothing when state is undefined", async () => {
      const app = await testRender(() => withTestTheme(() => (
        <VerificationBadge state={undefined} />
      )), { width: 80, height: 10 })
      try {
        const text = await renderFrame(app)
        expect(text).not.toContain("VERIFIED")
        expect(text).not.toContain("Verifying")
      } finally {
        app.renderer.destroy()
      }
    })

    test("renders running state with indicator", async () => {
      const state: TurnVerificationState = { status: "running" }
      const app = await testRender(() => withTestTheme(() => (
        <VerificationBadge state={state} />
      )), { width: 80, height: 10 })
      try {
        const text = await renderFrame(app)
        expect(text).toContain("Verifying changes...")
      } finally {
        app.renderer.destroy()
      }
    })

    test("renders completed VERIFIED state with explanation badge", async () => {
      const state: TurnVerificationState = {
        status: "completed",
        summary: {
          status: "VERIFIED",
          checks: [
            {
              kind: "test",
              label: "bun test",
              status: "passed",
              exitCode: 0,
              durationMs: 42,
              evidence: "12 pass, 0 fail",
            },
          ],
          explanation: "all behavioral tests passed",
        },
      }

      const app = await testRender(() => withTestTheme(() => (
        <VerificationBadge state={state} />
      )), { width: 80, height: 10 })
      try {
        const text = await renderFrame(app)
        expect(text).toContain("VERIFIED")
        expect(text).toContain("all behavioral tests passed")
      } finally {
        app.renderer.destroy()
      }
    })

    test("renders completed FAILED state", async () => {
      const state: TurnVerificationState = {
        status: "completed",
        summary: {
          status: "FAILED",
          checks: [
            {
              kind: "test",
              label: "pytest",
              status: "failed",
              exitCode: 1,
              durationMs: 120,
              evidence: "FAILED tests/test_core.py::test_basic - AssertionError",
            },
          ],
          explanation: "pytest failed with exit code 1",
        },
      }

      const app = await testRender(() => withTestTheme(() => (
        <VerificationBadge state={state} />
      )), { width: 80, height: 10 })
      try {
        const text = await renderFrame(app)
        expect(text).toContain("FAILED")
        expect(text).toContain("pytest failed with exit code 1")
      } finally {
        app.renderer.destroy()
      }
    })

    test("reacts to signal updates transitioning running -> completed", async () => {
      const [state, setState] = createSignal<TurnVerificationState>({ status: "running" })

      const app = await testRender(() => withTestTheme(() => (
        <VerificationBadge state={state()} />
      )), { width: 80, height: 10 })

      try {
        let text = await renderFrame(app)
        expect(text).toContain("Verifying changes...")

        setState({
          status: "completed",
          summary: {
            status: "VERIFIED",
            checks: [],
            explanation: "unit checks verified",
          },
        })

        text = await renderFrame(app)
        expect(text).toContain("VERIFIED")
        expect(text).toContain("unit checks verified")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  describe("TUI post-turn verification pipeline", () => {
    test("respects skip flag producing SKIPPED_BY_USER immediately", async () => {
      const mockClient: VerificationClient = {
        session: {
          diff: async () => ({ data: [{ file: "src/index.ts" }] }),
        },
      }

      const summary = await runVerificationPipeline({
        cwd: process.cwd(),
        client: mockClient,
        sessionID: "ses_skip_test",
        skip: true,
      })

      expect(summary.status).toBe("SKIPPED_BY_USER")
      expect(summary.explanation).toContain("Verification was skipped at your request.")
    })

    test("derives UNAVAILABLE when no files were changed during turn", async () => {
      const mockClient: VerificationClient = {
        session: {
          diff: async () => ({ data: [] }),
          messages: async () => ({ data: [] }),
        },
      }

      const summary = await runVerificationPipeline({
        cwd: process.cwd(),
        client: mockClient,
        sessionID: "ses_no_changes",
        changedFilesOverride: [],
      })

      expect(summary.status).toBe("UNAVAILABLE")
      expect(summary.explanation).toContain("No files were changed")
    })

    test("runs planned verification checks on turn-changed files", async () => {
      const mockClient: VerificationClient = {
        session: {
          diff: async () => ({ data: [{ file: "config.json" }] }),
        },
      }

      const summary = await runVerificationPipeline({
        cwd: process.cwd(),
        client: mockClient,
        sessionID: "ses_verified_test",
        changedFilesOverride: [{ path: "sample.json", kind: "modified" }],
        commandsOverride: [
          {
            kind: "test",
            label: "true test",
            command: "true",
          },
        ],
      })

      expect(summary.status).toBe("VERIFIED")
      expect(summary.checks.length).toBeGreaterThan(0)
    })
  })
})
