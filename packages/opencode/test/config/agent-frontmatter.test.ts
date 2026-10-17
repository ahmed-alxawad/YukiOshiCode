import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import path from "path"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"
import { ConfigAgentV1 } from "@yukioshi/core/v1/config/agent"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Global } from "@yukioshi/core/global"
import { Npm } from "@yukioshi/core/npm"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { ProjectTrust } from "@/project/trust"
import { InstanceRuntime } from "@/project/instance-runtime"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { provideInstanceEffect, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"

const decode = (data: object) => ConfigParse.schema(ConfigAgentV1.Info, data, "test:agent-frontmatter")

describe("agent frontmatter schema", () => {
  test("comma-separated tools string is an allowlist", () => {
    const agent = decode({ tools: "Read, Grep, Bash" })
    expect(agent.permission).toEqual({ "*": "deny", read: "allow", grep: "allow", bash: "allow" })
    expect(Object.keys(agent.permission!)).toEqual(["*", "read", "grep", "bash"])
  })

  test("tools as a string list is an allowlist", () => {
    const agent = decode({ tools: ["Read", "WebFetch", "WebSearch"] })
    expect(agent.permission).toEqual({ "*": "deny", read: "allow", webfetch: "allow", websearch: "allow" })
  })

  test("legacy tools record keeps its semantics (no wildcard deny)", () => {
    const agent = decode({ tools: { bash: true, write: false, webfetch: false } })
    expect(agent.permission).toEqual({ bash: "allow", edit: "deny", webfetch: "deny" })
    expect(agent.permission).not.toHaveProperty("*")
  })

  test("string/list tools keep deny-everything semantics over explicit permission", () => {
    const agent = decode({
      tools: "Read",
      permission: { "*": "allow", bash: "deny" },
    })
    expect(agent.permission).toEqual({ "*": "deny", bash: "deny", read: "allow" })
    expect(Object.keys(agent.permission!)).toEqual(["*", "bash", "read"])
  })

  test("maps Claude tool names case-insensitively", () => {
    const agent = decode({ tools: "read, EDIT, Write, MultiEdit, Bash, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite" })
    expect(agent.permission).toEqual({
      "*": "deny",
      read: "allow",
      edit: "allow",
      bash: "allow",
      grep: "allow",
      glob: "allow",
      webfetch: "allow",
      websearch: "allow",
      task: "allow",
      todowrite: "allow",
    })
  })

  test("maps Qwen tool names", () => {
    const agent = decode({
      tools: [
        "read_file",
        "read_many_files",
        "write_file",
        "run_shell_command",
        "grep_search",
        "web_fetch",
        "web_search",
        "todo_write",
      ],
    })
    expect(agent.permission).toEqual({
      "*": "deny",
      read: "allow",
      edit: "allow",
      bash: "allow",
      grep: "allow",
      webfetch: "allow",
      websearch: "allow",
      todowrite: "allow",
    })
  })

  test("maps mcp__server__tool and mcp__server__* to permission ids", () => {
    const agent = decode({ tools: "mcp__github__create_issue, mcp__docs__*" })
    expect(agent.permission).toEqual({
      "*": "deny",
      github_create_issue: "allow",
      "docs_*": "allow",
    })
  })

  test("unknown allowlist entries pass through lowercased", () => {
    const agent = decode({ tools: "Read, MyCustomTool" })
    expect(agent.permission).toEqual({ "*": "deny", read: "allow", mycustomtool: "allow" })
  })

  test("disallowedTools string denies after tools and explicit permission", () => {
    const agent = decode({
      tools: "Read, Bash",
      permission: { grep: "allow" },
      disallowedTools: "Bash",
    })
    expect(agent.permission).toEqual({ "*": "deny", read: "allow", bash: "deny", grep: "allow" })
  })

  test("disallowedTools list overrides an explicit allow (last match wins)", () => {
    const agent = decode({
      permission: { webfetch: "allow" },
      disallowedTools: ["WebFetch", "mcp__github__delete_repo"],
    })
    expect(agent.permission).toEqual({ webfetch: "deny", github_delete_repo: "deny" })
  })

  test("maxTurns maps to steps unless steps is set", () => {
    expect(decode({ maxTurns: 7 }).steps).toBe(7)
    expect(decode({ steps: 3, maxTurns: 7 }).steps).toBe(3)
  })

  test('model "inherit" omits the model', () => {
    const agent = decode({ model: "inherit" })
    expect(agent.model).toBeUndefined()
    expect(agent).not.toHaveProperty("model")
  })

  test("Claude model aliases omit the model", () => {
    for (const alias of ["sonnet", "opus", "haiku"]) {
      const agent = decode({ model: alias })
      expect(agent.model).toBeUndefined()
    }
    expect(decode({ model: "test/model" }).model).toBe("test/model")
  })

  test('permissionMode "default" and unknown values generate no rules', () => {
    expect(decode({ permissionMode: "default" }).permission).toEqual({})
    expect(decode({ permissionMode: "yolo" }).permission).toEqual({})
  })

  test('permissionMode "acceptEdits" allows edit', () => {
    expect(decode({ permissionMode: "acceptEdits" }).permission).toEqual({ edit: "allow" })
  })

  test('permissionMode "plan" denies non-read-only capabilities only', () => {
    const agent = decode({ permissionMode: "plan" })
    expect(agent.permission).toEqual({
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      task: "deny",
      delegate: "deny",
      external_directory: "deny",
      todowrite: "deny",
      memory_save: "deny",
      skill_save: "deny",
      lsp: "deny",
      skill: "deny",
    })
    for (const usable of ["read", "grep", "glob", "list", "websearch", "question"]) {
      expect(agent.permission).not.toHaveProperty(usable)
    }
  })

  test('permissionMode "bypassPermissions" grants nothing', () => {
    expect(decode({ permissionMode: "bypassPermissions" }).permission).toEqual({})
  })

  test("new frontmatter keys never leak into provider options", () => {
    const agent = decode({
      tools: "Read",
      disallowedTools: "Bash",
      maxTurns: 5,
      permissionMode: "plan",
      custom_option: 42,
    })
    expect(agent.options).toEqual({ custom_option: 42 })
  })
})

const unexpectedHttp = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected", { status: 500 }))),
)

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])
const it = testEffect(layer)

const clearEffect = Config.use
  .invalidate()
  .pipe(Effect.scoped, Effect.provide(layer), Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())))

beforeEach(() => Effect.runPromise(clearEffect))
afterEach(() => Effect.runPromise(clearEffect))

/** Loads the effective config for a project that carries markdown agent files. */
const resolve = (input: { agents: Record<string, string>; trusted?: boolean }) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    for (const [name, markdown] of Object.entries(input.agents)) {
      yield* FSUtil.use.writeWithDirs(path.join(directory, ".yukioshi", "agent", `${name}.md`), markdown)
    }
    if (input.trusted) {
      yield* Effect.promise(() => ProjectTrust.set(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(() => ProjectTrust.set(directory, false)).pipe(Effect.ignore))
    }
    const previous = Global.Path.config
    ;(Global.Path as { config: string }).config = global
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
    )
    yield* Config.use.invalidate()
    const config = yield* Config.use.get().pipe(
      Effect.provideService(TestInstance, { directory }),
      provideInstanceEffect(directory),
      Effect.provide(testInstanceStoreLayer),
      Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
    )
    return { config, directory }
  })

describe("agent markdown loader", () => {
  it.effect("warns and drops the model for Claude aliases, naming the agent file", () =>
    Effect.gen(function* () {
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      try {
        const { config, directory } = yield* resolve({
          trusted: true,
          agents: {
            alias: `---
model: sonnet
---
Alias agent`,
            quiet: `---
model: inherit
---
Quiet agent`,
          },
        })
        expect(config.agent?.["alias"]?.model).toBeUndefined()
        expect(config.agent?.["quiet"]?.model).toBeUndefined()

        const messages = warn.mock.calls.map((call) => String(call[0]))
        const file = path.join(directory, ".yukioshi", "agent", "alias.md")
        expect(messages.some((message) => message.includes(file))).toBe(true)
        // "inherit" is an explicit choice, not an alias: it stays silent.
        expect(messages.some((message) => message.includes(path.join(directory, ".yukioshi", "agent", "quiet.md")))).toBe(
          false,
        )
      } finally {
        warn.mockRestore()
      }
    }),
  )

  it.effect('warns and ignores permissionMode "bypassPermissions", naming the agent file', () =>
    Effect.gen(function* () {
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      try {
        const { config, directory } = yield* resolve({
          trusted: true,
          agents: {
            bypass: `---
permissionMode: bypassPermissions
---
Bypass agent`,
          },
        })
        expect(config.agent?.["bypass"]?.permission).toEqual({})

        const messages = warn.mock.calls.map((call) => String(call[0]))
        const file = path.join(directory, ".yukioshi", "agent", "bypass.md")
        expect(messages.some((message) => message.includes(file) && message.includes("bypassPermissions"))).toBe(true)
      } finally {
        warn.mockRestore()
      }
    }),
  )
})

describe("untrusted project markdown agents", () => {
  it.effect("cannot retain a bash allow from a tools allowlist", () =>
    Effect.gen(function* () {
      const { config } = yield* resolve({
        agents: {
          evil: `---
tools: Bash
---
Evil agent`,
        },
      })
      // The allowlist's bash allow is stripped; only the tightening deny survives.
      expect(config.agent?.["evil"]?.permission).toEqual({ "*": "deny" })
    }),
  )

  it.effect('permissionMode "bypassPermissions" grants nothing', () =>
    Effect.gen(function* () {
      const { config } = yield* resolve({
        agents: {
          evil: `---
permissionMode: bypassPermissions
permission:
  bash: allow
---
Evil agent`,
        },
      })
      const permission = config.agent?.["evil"]?.permission ?? {}
      expect(Object.values(permission)).not.toContain("allow")
      expect(permission).not.toHaveProperty("*")
    }),
  )
})
