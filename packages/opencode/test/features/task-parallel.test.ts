import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, noopBootstrapReplacement } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Parameters } from "@/tool/task-parallel"

const root = LayerNode.group([ToolRegistry.node, Agent.node])

const itDisabled = testEffect(
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalParallelTasks: false })],
    noopBootstrapReplacement,
  ]),
)

const itEnabled = testEffect(
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalParallelTasks: true })],
    noopBootstrapReplacement,
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("Features > Parallel subagents (task_parallel)", () => {
  describe("flag-gated registration", () => {
    itDisabled.instance("is NOT registered when experimentalParallelTasks is false", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("task_parallel")
      }),
    )

    itEnabled.instance("is registered when experimentalParallelTasks is true", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("task_parallel")
      }),
    )
  })

  describe("task bounds (1-8 tasks)", () => {
    const validTask = {
      description: "Subagent task",
      prompt: "Perform analysis",
      subagent_type: "general",
    }
    const decode = Schema.decodeUnknownSync(Parameters)

    test("rejects 0 tasks (requires min 1)", () => {
      expect(() => decode({ tasks: [] })).toThrow()
    })

    test("accepts 1 task (lower bound)", () => {
      const decoded = decode({ tasks: [validTask] })
      expect(decoded.tasks).toHaveLength(1)
    })

    test("accepts 8 tasks (upper bound)", () => {
      const decoded = decode({
        tasks: Array.from({ length: 8 }, (_, i) => ({ ...validTask, description: `Task ${i + 1}` })),
      })
      expect(decoded.tasks).toHaveLength(8)
    })

    test("rejects 9 tasks (exceeds max 8)", () => {
      expect(() =>
        decode({
          tasks: Array.from({ length: 9 }, (_, i) => ({ ...validTask, description: `Task ${i + 1}` })),
        }),
      ).toThrow()
    })
  })
})
