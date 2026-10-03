import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, noopBootstrapReplacement, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { SessionID, MessageID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MemoryPaths } from "@/memory/paths"
import { MemoryStore } from "@/memory/store"
import { RiskClassifier } from "@yukioshi/core/permission/risk"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = LayerNode.group([ToolRegistry.node, Agent.node])

const disabledLayer = TestConfig.layer()
const enabledLayer = TestConfig.layer({ get: () => Effect.succeed({ memory: { enabled: true } }) })

const itDisabled = testEffect(
  LayerNode.compile(root, [
    [Config.node, disabledLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    noopBootstrapReplacement,
  ]),
)
const itEnabled = testEffect(
  LayerNode.compile(root, [
    [Config.node, enabledLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    noopBootstrapReplacement,
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

async function ctxFor(agentName: string): Promise<Tool.Context> {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: agentName,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("Features > Project memory", () => {
  describe("tool registration", () => {
    itDisabled.instance("does NOT register memory_recall or memory_save when memory.enabled is unset", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("memory_recall")
        expect(ids).not.toContain("memory_save")
      }),
    )

    itEnabled.instance("registers memory_recall and memory_save when memory.enabled is true", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("memory_recall")
        expect(ids).toContain("memory_save")
      }),
    )
  })

  describe("risk classification", () => {
    test("classifies memory_recall as low-risk and memory_save as high-risk", () => {
      // In auto mode, low risk runs without prompt, while high risk asks for permission
      expect(RiskClassifier.classify("memory_recall")).toBe("low")
      expect(RiskClassifier.classify("memory_save")).toBe("high")
    })
  })

  describe("storage location and format", () => {
    test("stores memory as plain Markdown in YukiOshi data directory, one set per repository", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "yk-feat-mem-data-"))
      const repoDir = mkdtempSync(join(tmpdir(), "yk-feat-mem-repo-"))

      try {
        const ctx = { directory: repoDir, worktree: repoDir }
        const memoryRoot = MemoryPaths.root(ctx, dataDir)
        // Memory root must be under dataDir/memory/<identity>
        expect(memoryRoot.startsWith(join(dataDir, "memory"))).toBe(true)

        const files = MemoryPaths.files(memoryRoot)
        expect(files.project.endsWith("project.md")).toBe(true)
        expect(files.environment.endsWith("environment.md")).toBe(true)
        expect(files.corrections.endsWith("corrections.md")).toBe(true)

        // Save a memory entry using MemoryStore and verify Markdown file is written to disk
        await MemoryStore.remember({
          root: memoryRoot,
          file: "project.md",
          key: "tech-stack",
          text: "This project uses Effect and Bun.",
        })

        expect(existsSync(files.project)).toBe(true)
        const content = await MemoryStore.readSource(memoryRoot, "project.md")
        expect(content).toContain("tech-stack")
        expect(content).toContain("This project uses Effect and Bun.")

        // Verify isolation: another repository produces a distinct memory root
        const otherRepoDir = mkdtempSync(join(tmpdir(), "yk-feat-mem-other-"))
        const otherRoot = MemoryPaths.root({ directory: otherRepoDir, worktree: otherRepoDir }, dataDir)
        expect(otherRoot).not.toBe(memoryRoot)
        rmSync(otherRepoDir, { recursive: true, force: true })
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
        rmSync(repoDir, { recursive: true, force: true })
      }
    })
  })

  describe("end-to-end tool execution", () => {
    itEnabled.instance("saves and recalls memory via tool execute paths", () =>
      Effect.gen(function* () {
        yield* TestInstance
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const agentName = (yield* agents.defaultInfo()).name
        const ctx = yield* Effect.promise(() => ctxFor(agentName))

        const tools = yield* registry.all()
        const save = tools.find((t) => t.id === "memory_save")!
        const recall = tools.find((t) => t.id === "memory_recall")!

        const saveRes = yield* save.execute(
          { action: "remember", key: "build-system", text: "Built with bunfig" },
          ctx,
        )
        expect(saveRes.output).toContain("changed=true")

        const recallRes = yield* recall.execute({ mode: "search", query: "bunfig" }, ctx)
        expect(recallRes.output).toContain("build-system")
        expect(recallRes.output).toContain("Built with bunfig")
      }),
    )
  })
})
