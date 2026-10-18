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
const resolve = (input: { global?: object; project: object; trusted?: boolean; home?: Record<string, string>; files?: Record<string, string> }) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    if (input.global) yield* write(global, input.global)
    yield* write(directory, input.project)
    const home = yield* tmpdirScoped()
    for (const [file, text] of Object.entries(input.home ?? {})) yield* FSUtil.use.writeWithDirs(path.join(home, file), text)
    for (const [file, text] of Object.entries(input.files ?? {}))
      yield* FSUtil.use.writeWithDirs(path.join(directory, file), text)
    const previousHome = process.env.YUKIOSHI_TEST_HOME
    process.env.YUKIOSHI_TEST_HOME = home
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousHome === undefined) delete process.env.YUKIOSHI_TEST_HOME
        else process.env.YUKIOSHI_TEST_HOME = previousHome
      }),
    )
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


const agentMd = (extra = "") => `---\ndescription: test agent\n${extra}---\nDo things.\n`

describe("agent_sources claude", () => {
  const files = { ".claude/agents/proj.md": agentMd() }
  const home = { ".claude/agents/glob.md": agentMd() }

  it.effect("is off by default", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: {}, trusted: true, files, home })
      expect(config.agent?.proj).toBeUndefined()
      expect(config.agent?.glob).toBeUndefined()
    }),
  )

  it.effect("discovers home and project .claude agents when the global config enables it", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ global: { agent_sources: ["claude"] }, project: {}, trusted: true, files, home })
      expect(config.agent?.proj?.prompt).toBe("Do things.")
      expect(config.agent?.glob?.prompt).toBe("Do things.")
    }),
  )

  it.effect("a project config cannot enable it", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { agent_sources: ["claude"] }, trusted: true, files, home })
      expect(config.agent_sources).toBeUndefined()
      expect(config.agent?.proj).toBeUndefined()
      expect(config.agent?.glob).toBeUndefined()
    }),
  )

  it.effect("an untrusted project .claude agent cannot grant allow", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { agent_sources: ["claude"] },
        project: {},
        files: { ".claude/agents/proj.md": agentMd("permission:\n  bash: allow\n  edit: deny\n") },
        home,
      })
      expect(config.agent?.proj).toBeDefined()
      expect((config.agent?.proj?.permission as any)?.bash).toBeUndefined()
      expect((config.agent?.proj?.permission as any)?.edit).toBe("deny")
    }),
  )
})
