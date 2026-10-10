import { describe, expect } from "bun:test"
import { Effect, Logger } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

const run = (event: Hooks.EventName, key: "preToolUse" | "postToolUse", matcher: string) =>
  Effect.gen(function* () {
    const cwd = yield* tmpdirScoped()
    const hooks = yield* Hooks.Service
    return yield* hooks.run({
      hooks: { [key]: [{ matcher, command: "exit 2" }] },
      event,
      payload: {},
      cwd,
      toolName: "bash",
    })
  })

describe("hook with an invalid matcher", () => {
  it("a PreToolUse hook still runs (fails closed) so a broken guard cannot be skipped", () =>
    Effect.gen(function* () {
      const result = yield* run("PreToolUse", "preToolUse", "(unclosed")
      expect(result.ran).toBe(1)
      expect(result.blocked).toBeDefined()
    }))

  it("a PostToolUse hook is skipped", () =>
    Effect.gen(function* () {
      const result = yield* run("PostToolUse", "postToolUse", "[bad")
      expect(result.ran).toBe(0)
      expect(result.blocked).toBeUndefined()
    }))

  it("warns once per hook, not on every call", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const logger = {
        log: (options: { message: unknown }) => {
          logs.push(String(Array.isArray(options.message) ? options.message[0] : options.message))
        },
      }
      const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(logger.log as any)])))
      yield* capture(run("PreToolUse", "preToolUse", "(once-only"))
      yield* capture(run("PreToolUse", "preToolUse", "(once-only"))
      yield* capture(run("PostToolUse", "postToolUse", "[once-only"))
      expect(logs.filter((line) => line.includes("not a valid regular expression")).length).toBe(2)
    }))
})
