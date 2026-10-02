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
const enabledLayer = TestConfig.layer({ get: () => Effect.succeed({ code_graph: { enabled: true } }) })

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

describe("code_graph tool registration", () => {
  itDisabled.instance("is not registered when code_graph.enabled is unset", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).not.toContain("code_graph")
    }),
  )

  it.instance("is registered when code_graph.enabled is true", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("code_graph")
    }),
  )
})

describe("code_graph fallback path", () => {
  it.instance("reports an unavailable graph without requiring Graphify", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agentName = (yield* agents.defaultInfo()).name
      const tool = (yield* registry.all()).find((item) => item.id === "code_graph")!

      const result = yield* tool.execute({ operation: "status" }, yield* Effect.promise(() => ctxFor(agentName)))
      expect(result.output).toContain("signals only")
      expect(result.output).toContain("No Graphify graph found")
      expect(result.metadata).toMatchObject({ provider: "local", available: false })
    }),
  )
})
