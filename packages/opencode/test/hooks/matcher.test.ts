import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

// A hook that blocks when it runs: `blocked` tells whether the matcher selected it.
const selected = (matcher: string | undefined, toolName: string | undefined) =>
  Effect.gen(function* () {
    const cwd = yield* tmpdirScoped()
    const hooks = yield* Hooks.Service
    const result = yield* hooks.run({
      hooks: { preToolUse: [{ ...(matcher === undefined ? {} : { matcher }), command: "exit 2" }] },
      event: "PreToolUse",
      payload: {},
      cwd,
      toolName,
    })
    return result.ran === 1 && result.blocked !== undefined
  })

describe("hook matcher", () => {
  it("runs when there is no matcher, an empty matcher, or a wildcard", () =>
    Effect.gen(function* () {
      expect(yield* selected(undefined, "bash")).toBe(true)
      expect(yield* selected("", "bash")).toBe(true)
      expect(yield* selected("*", "bash")).toBe(true)
    }))

  it("runs for events without a tool name whatever the matcher says", () =>
    Effect.gen(function* () {
      expect(yield* selected("write", undefined)).toBe(true)
    }))

  it("anchors the pattern to the whole tool name", () =>
    Effect.gen(function* () {
      expect(yield* selected("bash", "bash")).toBe(true)
      expect(yield* selected("bash", "bash2")).toBe(false)
      expect(yield* selected("ash", "bash")).toBe(false)
      expect(yield* selected("bash", "my_bash")).toBe(false)
    }))

  it("anchors every alternative, not only the first and last", () =>
    Effect.gen(function* () {
      expect(yield* selected("write|edit", "write")).toBe(true)
      expect(yield* selected("write|edit", "edit")).toBe(true)
      expect(yield* selected("write|edit", "rewrite")).toBe(false)
      expect(yield* selected("write|edit", "editor")).toBe(false)
    }))

  it("supports regular expression syntax", () =>
    Effect.gen(function* () {
      expect(yield* selected("mcp__.*", "mcp__github__create_issue")).toBe(true)
      expect(yield* selected("mcp__.*", "bash")).toBe(false)
      expect(yield* selected("(read|glob)", "glob")).toBe(true)
    }))

  it("is case sensitive", () =>
    Effect.gen(function* () {
      expect(yield* selected("Bash", "bash")).toBe(false)
    }))

  it("does not let a '.*' trick match across alternatives into an unrelated tool", () =>
    Effect.gen(function* () {
      expect(yield* selected("read", "read\nbash")).toBe(false)
    }))

  it("does not run, and does not throw, for an invalid regular expression", () =>
    Effect.gen(function* () {
      expect(yield* selected("(", "bash")).toBe(false)
      expect(yield* selected("[", "bash")).toBe(false)
      expect(yield* selected("*bash", "bash")).toBe(false)
    }))

  it("handles unicode tool names and very long names", () =>
    Effect.gen(function* () {
      expect(yield* selected("ツール", "ツール")).toBe(true)
      expect(yield* selected("a+", "a".repeat(100_000))).toBe(true)
    }))
})
