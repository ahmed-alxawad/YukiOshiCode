import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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


import { SessionLearning } from "../../src/session/learning"
import type { SessionV1 } from "@yukioshi/core/v1/session"

const user = (id: string) => ({ info: { id, role: "user" }, parts: [] }) as unknown as SessionV1.WithParts
const tool = (status: string) => ({ type: "tool", state: { status } })
const assistant = (id: string, statuses: string[]) =>
  ({ info: { id, role: "assistant" }, parts: statuses.map(tool) }) as unknown as SessionV1.WithParts
const turn = (n: number, statuses: string[]) => [user(`u${n}`), assistant(`a${n}`, statuses)]
const many = (n: number) => Array.from({ length: n }, () => "completed")

describe("learning nudges", () => {
  beforeEach(() => SessionLearning.reset())

  test("default off injects nothing, however long the turn", () => {
    const messages = [...turn(1, many(30)), user("u2")]
    expect(SessionLearning.nudge({ sessionID: "s", messages })).toBeUndefined()
    expect(SessionLearning.nudge({ sessionID: "s", messages, enabled: false })).toBeUndefined()
  })

  test("on: injects at the threshold only", () => {
    expect(SessionLearning.nudge({ sessionID: "a", enabled: true, messages: [...turn(1, many(7)), user("u2")] })).toBeUndefined()
    expect(SessionLearning.nudge({ sessionID: "b", enabled: true, messages: [...turn(1, many(8)), user("u2")] })).toBe(
      SessionLearning.REMINDER,
    )
    expect(
      SessionLearning.nudge({ sessionID: "c", enabled: true, minToolCalls: 3, messages: [...turn(1, many(3)), user("u2")] }),
    ).toBe(SessionLearning.REMINDER)
  })

  test("on: a failing call followed by success counts, a failure alone does not", () => {
    const fixed = [...turn(1, ["error", "completed"]), user("u2")]
    expect(SessionLearning.nudge({ sessionID: "d", enabled: true, messages: fixed })).toBe(SessionLearning.REMINDER)
    const unfixed = [...turn(1, ["completed", "error"]), user("u2")]
    expect(SessionLearning.nudge({ sessionID: "e", enabled: true, messages: unfixed })).toBeUndefined()
  })

  test("rate limit: at most once per every_turns; stable within the nudged turn", () => {
    const base = { sessionID: "r", enabled: true, everyTurns: 3 }
    const t1 = [...turn(1, many(9)), user("u2")]
    expect(SessionLearning.nudge({ ...base, messages: t1 })).toBe(SessionLearning.REMINDER)
    expect(SessionLearning.nudge({ ...base, messages: t1 })).toBe(SessionLearning.REMINDER)
    const t2 = [...turn(1, many(9)), ...turn(2, many(9)), user("u3")]
    expect(SessionLearning.nudge({ ...base, messages: t2 })).toBeUndefined()
    const t3 = [...t2.slice(0, -1), ...turn(3, many(9)), user("u4")]
    expect(SessionLearning.nudge({ ...base, messages: t3 })).toBeUndefined()
    const t4 = [...t3.slice(0, -1), ...turn(4, many(9)), user("u5")]
    expect(SessionLearning.nudge({ ...base, messages: t4 })).toBe(SessionLearning.REMINDER)
  })

  test("no memory or skill tool: nothing to suggest", () => {
    expect(
      SessionLearning.nudge({ sessionID: "t", enabled: true, tools: false, messages: [...turn(1, many(9)), user("u2")] }),
    ).toBeUndefined()
  })
})

describe("learning config", () => {
  it.effect("is off by default", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: {}, trusted: true })
      expect(config.learning?.nudges).toBeUndefined()
    }),
  )

  it.effect("global config turns it on", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ global: { learning: { nudges: true } }, project: {}, trusted: true })
      expect(config.learning?.nudges).toBe(true)
    }),
  )

  it.effect("a project config cannot enable it, trusted or not", () =>
    Effect.gen(function* () {
      for (const trusted of [true, false]) {
        const config = yield* resolve({ project: { learning: { nudges: true, min_tool_calls: 1 } }, trusted })
        expect(config.learning).toBeUndefined()
      }
    }),
  )

  it.effect("toggling persists in the global config file", () =>
    Effect.gen(function* () {
      const global = yield* tmpdirScoped()
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = global
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { config: string }).config = previous)))
      yield* Config.use.updateGlobal({ learning: { nudges: true } })
      const read = () => FSUtil.use.readFileString(path.join(global, "yukioshi.jsonc"))
      expect(yield* read()).toMatch(/"nudges": true/)
      yield* Config.use.updateGlobal({ learning: { nudges: false } })
      expect(yield* read()).toMatch(/"nudges": false/)
    }),
  )
})
