import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

// A guard that cannot run, as on a machine without the interpreter it needs.
const broken = (failClosed: boolean | undefined, event: "PreToolUse" | "PostToolUse" = "PreToolUse") =>
  Effect.gen(function* () {
    const cwd = yield* tmpdirScoped()
    const hooks = yield* Hooks.Service
    const hook = { command: "exit 127", ...(failClosed === undefined ? {} : { failClosed }) }
    return yield* hooks.run({
      hooks: event === "PreToolUse" ? { preToolUse: [hook] } : { postToolUse: [hook] },
      event,
      payload: {},
      cwd,
      toolName: "bash",
    })
  })

describe("hook failClosed", () => {
  it("by default a failing guard warns and the call goes ahead", () =>
    Effect.gen(function* () {
      const result = yield* broken(undefined)
      expect(result.blocked).toBeUndefined()
      expect(result.warnings[0]).toContain("exited with code 127")
    }))

  it("with failClosed a failing guard blocks the call", () =>
    Effect.gen(function* () {
      const result = yield* broken(true)
      expect(result.blocked).toContain("exited with code 127")
      expect(result.blocked).toContain("failClosed")
    }))

  it("failClosed does not turn a PostToolUse failure into a block", () =>
    Effect.gen(function* () {
      const result = yield* broken(true, "PostToolUse")
      expect(result.blocked).toBeUndefined()
      expect(result.warnings).toHaveLength(1)
    }))
})
