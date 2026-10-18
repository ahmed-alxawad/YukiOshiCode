import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

describe("Hooks.withAgent", () => {
  it("an agent's hooks run after the global ones, and only for that agent", () =>
    Effect.gen(function* () {
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service
      const global: ConfigHooksV1.Info = { preToolUse: [{ command: "echo global >&2; exit 0" }] }
      const agent = { preToolUse: [{ command: "echo agent >&2; exit 2" }], stop: [{ command: "exit 0" }] }
      const run = (merged: ConfigHooksV1.Info | undefined) =>
        hooks.run({ hooks: merged, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })

      // A session of another agent (or none) gets the global hooks only.
      const other = yield* run(Hooks.withAgent(global, undefined))
      expect(other.ran).toBe(1)
      expect(other.blocked).toBeUndefined()

      const own = yield* run(Hooks.withAgent(global, agent))
      expect(own.ran).toBe(2)
      expect(own.blocked).toBe("agent")

      expect(Hooks.withAgent(global, agent)?.stop).toHaveLength(1)
      expect(Hooks.withAgent(global, agent, true)?.subagentStop).toHaveLength(1)
      expect(Hooks.withAgent(global, agent, true)?.stop).toBeUndefined()
      expect(global.preToolUse).toHaveLength(1)
    }),
  )
})
