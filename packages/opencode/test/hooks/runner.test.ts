import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

function withCwd<A, E, R>(fn: (cwd: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const cwd = yield* tmpdirScoped()
    return yield* fn(cwd)
  })
}

describe("Hooks.Service", () => {
  it("returns ran: 0 and no warnings when no hooks are configured", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const result = yield* hooks.run({ hooks: undefined, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
        expect(result).toEqual({ context: [], warnings: [], ran: 0 })
      }),
    ),
  )

  it("skips a hook whose matcher does not match the tool name", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const cfg: ConfigHooksV1.Info = { preToolUse: [{ matcher: "write|edit", command: "exit 2" }] }
        const result = yield* hooks.run({ hooks: cfg, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
        expect(result.ran).toBe(0)
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  it("blocks when a hook exits with code 2, using stderr as the reason", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const script = path.join(cwd, "block.ts")
        yield* Effect.promise(() =>
          Bun.write(script, "process.stderr.write('no deletes allowed'); process.exit(2)\n"),
        )
        const cfg: ConfigHooksV1.Info = {
          preToolUse: [{ matcher: "*", command: "bun block.ts" }],
        }
        const result = yield* hooks.run({ hooks: cfg, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
        expect(result.blocked).toBe("no deletes allowed")
        expect(result.ran).toBe(1)
      }),
    ),
  )

  it("blocks on a JSON {decision: block} response from stdout", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const cfg: ConfigHooksV1.Info = {
          preToolUse: [{ matcher: "*", command: `echo '{"decision":"block","reason":"policy"}'` }],
        }
        const result = yield* hooks.run({ hooks: cfg, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
        expect(result.blocked).toBe("policy")
      }),
    ),
  )

  it("adds stdout as context for UserPromptSubmit on a plain exit 0", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const cfg: ConfigHooksV1.Info = { userPromptSubmit: [{ command: "echo 'git status: clean'" }] }
        const result = yield* hooks.run({ hooks: cfg, event: "UserPromptSubmit", payload: {} , cwd })
        expect(result.blocked).toBeUndefined()
        expect(result.context).toEqual(["git status: clean"])
      }),
    ),
  )

  it("warns (without blocking) on a non-2 nonzero exit code", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const cfg: ConfigHooksV1.Info = { postToolUse: [{ command: "exit 1" }] }
        const result = yield* hooks.run({ hooks: cfg, event: "PostToolUse", payload: {}, cwd, toolName: "write" })
        expect(result.blocked).toBeUndefined()
        expect(result.warnings).toHaveLength(1)
      }),
    ),
  )

  it("runs multiple hooks in order and stops at the first that blocks", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const cfg: ConfigHooksV1.Info = {
          preToolUse: [{ command: "exit 2" }, { command: "echo should-not-run > /dev/null" }],
        }
        const result = yield* hooks.run({ hooks: cfg, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
        expect(result.blocked).toBe("Blocked by a PreToolUse hook.")
        expect(result.ran).toBe(2)
      }),
    ),
  )

  it("has() reflects whether the event has any configured commands", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      expect(hooks.has(undefined, "PreToolUse")).toBe(false)
      expect(hooks.has({ preToolUse: [] }, "PreToolUse")).toBe(false)
      expect(hooks.has({ preToolUse: [{ command: "true" }] }, "PreToolUse")).toBe(true)
    }),
  )
})
