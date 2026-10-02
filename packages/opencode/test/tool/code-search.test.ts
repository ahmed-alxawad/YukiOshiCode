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
// Enabled but no provider credentials configured - exercises the "Standby, not configured" path
// without ever making a network call (see Indexing.Service.ensure() and manager.initialize()).
const enabledLayer = TestConfig.layer({ get: () => Effect.succeed({ indexing: { enabled: true } }) })

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

describe("code_search tool registration", () => {
  itDisabled.instance("is not registered when indexing.enabled is unset", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("code_search")
    }),
  )

  it.instance("is registered when indexing.enabled is true", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("code_search")
    }),
  )
})

describe("code_search tool execution", () => {
  it.instance(
    "reports not-available without crashing when indexing is enabled but no provider credentials are set",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const agentName = (yield* agents.defaultInfo()).name
        const ctx = yield* Effect.promise(() => ctxFor(agentName))

        const tools = yield* registry.all()
        const tool = tools.find((t) => t.id === "code_search")!

        const result = yield* tool.execute({ query: "rate limiting logic" }, ctx)
        expect(result.output).toContain("isn't active yet")
        expect(result.output).toContain("not configured")
        expect(result.metadata).toMatchObject({ count: 0 })
      }),
  )
})
