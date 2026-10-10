import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import path from "path"
import { Config } from "@/config/config"
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
import {
  provideInstanceEffect,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"

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

const schemaConfig = (config: object) => ({ $schema: "https://opencode.ai/config.json", ...config })
const write = (dir: string, config: object) =>
  FSUtil.use.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(schemaConfig(config)))

/** Loads the effective config for a project directory; `trusted` decides whether its config is filtered. */
const resolve = (input: { global?: object; project: object; trusted?: boolean }) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    if (input.global) yield* write(global, input.global)
    yield* write(directory, input.project)
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
    return yield* Config.use.get().pipe(
      Effect.provideService(TestInstance, { directory }),
      provideInstanceEffect(directory),
      Effect.provide(testInstanceStoreLayer),
      Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
    )
  })

describe("untrusted project cannot weaken the user's deny", () => {
  it.effect("ask on a key the user denies is dropped (simple form)", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { webfetch: "deny" } },
        project: { permission: { webfetch: "ask" } },
      })
      expect(config.permission?.webfetch).toBe("deny")
    }),
  )

  it.effect("ask on a pattern the user denies is dropped (pattern map)", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { bash: { "rm *": "deny" } } },
        project: { permission: { bash: { "rm *": "ask", "*": "ask" } } },
      })
      expect(config.permission?.bash).toEqual({ "rm *": "deny" })
    }),
  )

  it.effect("a project deny is still accepted and a non-conflicting ask is kept", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { webfetch: "deny", edit: "ask" } },
        project: { permission: { read: "deny", grep: "ask", bash: { "git push *": "deny" } } },
      })
      expect(config.permission?.read).toBe("deny")
      expect(config.permission?.grep).toBe("ask")
      expect(config.permission?.bash).toEqual({ "git push *": "deny" })
      expect(config.permission?.webfetch).toBe("deny")
    }),
  )

  it.effect("a whole-key ask or deny map cannot replace the user's pattern map or whole-key deny", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { bash: { "git status": "allow", "rm *": "deny" }, edit: "deny" } },
        project: { permission: { bash: "ask", edit: { "*.md": "deny" } } },
      })
      expect(config.permission?.bash).toEqual({ "git status": "allow", "rm *": "deny" })
      expect(config.permission?.edit).toBe("deny")
    }),
  )

  it.effect("a whole-key ask does not wipe a user's allow-only pattern map", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { bash: { "git status": "allow" } } },
        project: { permission: { bash: "ask" } },
      })
      expect(config.permission?.bash).toEqual({ "git status": "allow" })
    }),
  )

  it.effect("a pattern map over a user whole-key rule keeps that rule as its base", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { bash: "allow" } },
        project: { permission: { bash: { "rm *": "deny" } } },
      })
      expect(config.permission?.bash).toEqual({ "*": "allow", "rm *": "deny" })
    }),
  )

  it.effect("a wildcard key cannot ask over a user deny", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { webfetch: "deny" } },
        project: { permission: { "*": "ask" } },
      })
      expect(config.permission?.["*"]).toBeUndefined()
      expect(config.permission?.webfetch).toBe("deny")
    }),
  )

  it.effect("agents cannot ask over the user's agent deny", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { agent: { build: { permission: { webfetch: "deny" } } } },
        project: { agent: { build: { permission: { webfetch: "ask" } } } },
      })
      expect(config.agent?.build?.permission?.webfetch).toBe("deny")
    }),
  )

  it.effect("a trusted project may still loosen deny to ask", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { webfetch: "deny" } },
        project: { permission: { webfetch: "ask" } },
        trusted: true,
      })
      expect(config.permission?.webfetch).toBe("ask")
    }),
  )
})
