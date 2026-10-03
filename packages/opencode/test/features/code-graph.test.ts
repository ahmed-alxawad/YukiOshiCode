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

describe("Features > Code graph", () => {
  describe("tool registration", () => {
    itDisabled.instance("is NOT registered when code_graph.enabled is unset", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("code_graph")
      }),
    )

    itEnabled.instance("is registered when code_graph.enabled is true", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("code_graph")
      }),
    )
  })

  describe("graceful fallback without Graphify graph", () => {
    itEnabled.instance(
      "falls back cleanly when graphify-out/graph.json is missing without throwing errors",
      () =>
        Effect.gen(function* () {
          yield* TestInstance
          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const agentName = (yield* agents.defaultInfo()).name
          const ctx = yield* Effect.promise(() => ctxFor(agentName))

          const tools = yield* registry.all()
          const tool = tools.find((item) => item.id === "code_graph")
          expect(tool).toBeDefined()

          // Operation "status" returns available: false and descriptive message
          const statusResult = yield* tool!.execute({ operation: "status" }, ctx)
          expect(statusResult.output).toContain("Graph answers are signals only")
          expect(statusResult.output).toContain("No Graphify graph found")
          expect(statusResult.metadata).toMatchObject({ provider: "local", available: false })

          // Operation "important_files" falls back gracefully
          const filesResult = yield* tool!.execute({ operation: "important_files" }, ctx)
          expect(filesResult.output).toContain("Graph answers are signals only")
          expect(filesResult.metadata).toMatchObject({ provider: "local", available: false })
        }),
    )
  })
})
