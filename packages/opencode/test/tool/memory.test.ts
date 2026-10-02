import { afterEach, describe, expect } from "bun:test"
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
const it = testEffect(
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

describe("memory tools registration", () => {
  itDisabled.instance("are not registered when memory.enabled is unset", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("memory_recall")
      expect(ids).not.toContain("memory_save")
    }),
  )

  it.instance("are registered when memory.enabled is true", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("memory_recall")
      expect(ids).toContain("memory_save")
    }),
  )
})

describe("memory tools end to end", () => {
  it.instance("remember, recall, and forget round-trip through the real tool execute paths", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agentName = (yield* agents.defaultInfo()).name
      const ctx = yield* Effect.promise(() => ctxFor(agentName))

      const tools = yield* registry.all()
      const save = tools.find((tool) => tool.id === "memory_save")
      const recall = tools.find((tool) => tool.id === "memory_recall")
      if (!save || !recall) throw new Error("memory tools were not registered")

      const saved = yield* save.execute(
        { action: "remember", text: "This project uses bun workspaces", key: "pkg-manager" },
        ctx,
      )
      expect(saved.output).toContain("key=pkg-manager")
      expect(saved.output).toContain("changed=true")

      const searched = yield* recall.execute({ mode: "search", query: "bun workspaces" }, ctx)
      expect(searched.output).toContain("pkg-manager")
      expect(searched.output).toContain("This project uses bun workspaces")

      const catalog = yield* recall.execute({ mode: "catalog" }, ctx)
      expect(catalog.output).toContain("pkg-manager")

      const forgotten = yield* save.execute({ action: "forget", query: "pkg-manager" }, ctx)
      expect(forgotten.output).toContain("removed=1")

      const searchedAgain = yield* recall.execute({ mode: "search", query: "bun workspaces" }, ctx)
      expect(searchedAgain.title).toBe("Memory search: no results")
    }),
  )

  it.instance("correct saves into corrections.md separately from remember", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agentName = (yield* agents.defaultInfo()).name
      const ctx = yield* Effect.promise(() => ctxFor(agentName))

      const tools = yield* registry.all()
      const save = tools.find((tool) => tool.id === "memory_save")
      if (!save) throw new Error("memory_save was not registered")

      const result = yield* save.execute({ action: "correct", text: "Always use bun, never npm" }, ctx)
      expect(result.metadata).toMatchObject({ sources: ["corrections.md"] })
    }),
  )

  it.instance("memory_save with no text returns a guidance message instead of saving", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agentName = (yield* agents.defaultInfo()).name
      const ctx = yield* Effect.promise(() => ctxFor(agentName))

      const tools = yield* registry.all()
      const save = tools.find((tool) => tool.id === "memory_save")
      if (!save) throw new Error("memory_save was not registered")

      const result = yield* save.execute({ action: "remember" }, ctx)
      expect(result.title).toBe("Memory remember: no text")
    }),
  )
})
