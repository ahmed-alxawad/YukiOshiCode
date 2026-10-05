import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { execSync } from "child_process"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { noopBootstrapReplacement } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { runDelegate } from "@/delegate/client"
import { DelegateTool } from "@/tool/delegate"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"

const mockScript = path.resolve(__dirname, "mock-acp-agent.ts")
const bunBin = process.execPath

const root = LayerNode.group([ToolRegistry.node, Agent.node])

const withDelegateDisabled = testEffect(
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ delegate: { enabled: false } }) })],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    noopBootstrapReplacement,
  ]),
)

const withDelegateNoAgents = testEffect(
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ delegate: { enabled: true, agents: {} } }) })],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    noopBootstrapReplacement,
  ]),
)

const withDelegateEnabled = testEffect(
  LayerNode.compile(root, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            delegate: {
              enabled: true,
              agents: {
                mockAgent: { command: [bunBin, mockScript, "normal"] },
              },
            },
          }),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    noopBootstrapReplacement,
  ]),
)

describe("delegate: ToolRegistry gating and DelegateTool execution", () => {
  withDelegateDisabled.instance("tool is absent when delegate.enabled is false", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("delegate")
    }),
  )

  withDelegateNoAgents.instance("tool is absent when delegate.agents is empty", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("delegate")
    }),
  )

  withDelegateEnabled.instance("tool is present when delegate is enabled with at least one agent", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("delegate")
    }),
  )

  withDelegateEnabled.instance("DelegateTool execute fails if agent is not configured", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const tool = all.find((t) => t.id === "delegate")!
      expect(tool).toBeDefined()

      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const exit = yield* Effect.exit(tool.execute({ agent: "unknown", prompt: "hi" }, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const die = exit.cause.reasons.find(Cause.isDieReason)
        expect(String(die?.defect)).toContain('Agent "unknown" is not configured. Available agents: mockAgent')
      }
    }),
  )

  withDelegateEnabled.instance("DelegateTool execute runs external agent and returns formatted output", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const tool = all.find((t) => t.id === "delegate")!
      expect(tool).toBeDefined()

      const asked: any[] = []
      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (req) => {
          asked.push(req)
          return Effect.void
        },
      }

      const res = yield* tool.execute({ agent: "mockAgent", prompt: "list files" }, ctx)
      expect(res.title).toBe("Delegate: mockAgent")
      expect(res.output).toContain("Listing files in directory:")
      expect(res.output).toContain("Files changed:")
      expect(res.output).toContain("file1.txt")
      expect(asked.length).toBeGreaterThan(0)
      expect(asked[0].permission).toBe("delegate")
    }),
  )
})

describe("delegate: ACP client execution with mock agent", () => {
  const mockScript = path.resolve(__dirname, "mock-acp-agent.ts")
  const tempBase = process.env.TMPDIR || "/var/tmp/yk-test"
  const bunBin = process.execPath

  const makeTestDir = async (name: string) => {
    const dir = path.join(tempBase, `delegate-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  test("full roundtrip: sends prompt, streams chunks, reports files changed", async () => {
    const testCwd = await makeTestDir("roundtrip")
    try {
      const progressTitles: string[] = []
      const result = await runDelegate({
        agentName: "mock",
        agentConfig: {
          command: [bunBin, mockScript, "normal"],
        },
        prompt: "list the files in this folder",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        onProgress: (title) => {
          progressTitles.push(title)
        },
        askPermission: async () => ({ outcome: "cancelled" }),
      })

      expect(result.finalMessage).toContain("Listing files in directory:")
      expect(result.finalMessage).toContain("- file1.txt")
      expect(result.finalMessage).toContain("- file2.ts")
      expect(result.filesChanged).toContain("file1.txt")
      expect(result.filesChanged).toContain("file2.ts")
      expect(result.stopReason).toBe("end_turn")
      expect(progressTitles.some((t) => t.includes("working..."))).toBe(true)
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("file writes: agent creates file via writeTextFile and reports it", async () => {
    const testCwd = await makeTestDir("file-write")
    try {
      const result = await runDelegate({
        agentName: "mock",
        agentConfig: {
          command: [bunBin, mockScript, "write-file"],
        },
        prompt: "create a file",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async () => ({ outcome: "cancelled" }),
      })

      expect(result.filesChanged).toContain("created-by-agent.txt")
      const createdContent = await fs.readFile(path.join(testCwd, "created-by-agent.txt"), "utf-8")
      expect(createdContent).toBe("File content written over ACP")
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("permission forwarding: user allows permission request", async () => {
    const testCwd = await makeTestDir("perm-allow")
    try {
      const result = await runDelegate({
        agentName: "mock",
        agentConfig: {
          command: [bunBin, mockScript, "with-permission"],
        },
        prompt: "run command with permission",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async (_toolCall, options) => {
          const allow = options.find((o) => o.kind === "allow_once")!
          return { outcome: "selected", optionId: allow.optionId }
        },
      })

      expect(result.finalMessage).toContain('Permission outcome: {"outcome":"selected","optionId":"allow_1"}')
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("permission forwarding: user denies permission request", async () => {
    const testCwd = await makeTestDir("perm-deny")
    try {
      const result = await runDelegate({
        agentName: "mock",
        agentConfig: {
          command: [bunBin, mockScript, "with-permission"],
        },
        prompt: "run command with permission",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async (_toolCall, options) => {
          const deny = options.find((o) => o.kind === "reject_once")!
          return { outcome: "selected", optionId: deny.optionId }
        },
      })

      expect(result.finalMessage).toContain('Permission outcome: {"outcome":"selected","optionId":"deny_1"}')
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("error handling: ENOENT when agent binary does not exist", async () => {
    const testCwd = await makeTestDir("enoent")
    let err: Error | null = null
    try {
      await runDelegate({
        agentName: "nonexistent-agent",
        agentConfig: {
          command: ["non-existent-binary-cmd-xyz-987"],
        },
        prompt: "hello",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async () => ({ outcome: "cancelled" }),
      })
    } catch (e: any) {
      err = e
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }

    expect(err).not.toBeNull()
    expect(err!.message).toContain('Agent "nonexistent-agent" failed to start')
    expect(err!.message).toContain("non-existent-binary-cmd-xyz-987")
    expect(err!.message).toContain("Ensure")
    expect(err!.message).toContain("is installed and available in PATH")
  })

  test("error handling: auth error exits cleanly with login instructions", async () => {
    const testCwd = await makeTestDir("auth-err")
    let err: Error | null = null
    try {
      await runDelegate({
        agentName: "mock-auth",
        agentConfig: {
          command: [bunBin, mockScript, "auth-error"],
        },
        prompt: "hello",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async () => ({ outcome: "cancelled" }),
      })
    } catch (e: any) {
      err = e
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }

    expect(err).not.toBeNull()
    expect(err!.message).toContain('Agent "mock-auth" is not logged in')
    expect(err!.message).toContain("Please log in first using")
    expect(err!.message).toContain("mock-auth login")
  })

  test("timeout handling: terminates child process when timeout is reached", async () => {
    const testCwd = await makeTestDir("timeout")
    let err: Error | null = null
    const startTime = Date.now()
    try {
      await runDelegate({
        agentName: "mock-timeout",
        agentConfig: {
          command: [bunBin, mockScript, "hang"],
          timeout: 400 as any,
        },
        prompt: "hello",
        cwd: testCwd,
        abortSignal: new AbortController().signal,
        askPermission: async () => ({ outcome: "cancelled" }),
      })
    } catch (e: any) {
      err = e
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }

    const elapsed = Date.now() - startTime
    expect(err).not.toBeNull()
    expect(err!.message).toContain('Delegation to "mock-timeout" timed out after 400ms.')
    expect(elapsed).toBeLessThan(3000)
  })

  test("turn cancellation: sends ACP cancel, cleans up child process without orphans", async () => {
    const testCwd = await makeTestDir("cancel")
    const abortController = new AbortController()
    let err: Error | null = null

    // Cancel after 250ms once connection and prompt are active
    setTimeout(() => {
      abortController.abort()
    }, 250)

    try {
      await runDelegate({
        agentName: "mock-cancel",
        agentConfig: {
          command: [bunBin, mockScript, "sleep-during-prompt"],
        },
        prompt: "sleep prompt",
        cwd: testCwd,
        abortSignal: abortController.signal,
        askPermission: async () => ({ outcome: "cancelled" }),
      })
    } catch (e: any) {
      err = e
    } finally {
      await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {})
    }

    expect(err).not.toBeNull()
    expect(err!.message).toContain("Delegation aborted.")

    // Give 500ms to ensure process cleanup has fully finished
    await new Promise((r) => setTimeout(r, 500))

    // Check with ps that no orphan mock-acp-agent process is running
    try {
      const psOutput = execSync("ps aux | grep mock-acp-agent.ts | grep sleep-during-prompt | grep -v grep", {
        encoding: "utf-8",
      })
      expect(psOutput.trim()).toBe("")
    } catch (e: any) {
      // Exit code 1 means no matching processes found, which is desired!
      expect(e.status).toBe(1)
    }
  })
})
