import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNodePlatform } from "@yukioshi/core/effect/app-node-platform"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import { ModelsDev } from "@yukioshi/core/models-dev"
import { it } from "./lib/effect"
import { readFile, rm, writeFile, utimes, mkdir } from "fs/promises"
import path from "path"

// test/preload.ts pins YUKIOSHI_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.YUKIOSHI_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.YUKIOSHI_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.YUKIOSHI_MODELS_PATH = undefined
  Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.YUKIOSHI_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.YUKIOSHI_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

const cacheFile = path.join(Global.Path.cache, "models.json")

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required because the ModelsDev implementation is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeMockClient(state))],
    ]),
  )

const writeCacheText = (text: string, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile, text)
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const writeCache = (data: object, mtimeMs?: number) => writeCacheText(JSON.stringify(data), mtimeMs)

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
})

const initialState: MockState = { body: JSON.stringify(fixture), status: 200, calls: [] }

const zen = (id: string, api: string): ModelsDev.Provider => ({ ...fixture.acme!, id, name: id, api })

describe("ModelsDev opencode providers", () => {
  const mixed = {
    ...fixture,
    opencode: zen("opencode", "https://opencode.ai/zen/v1"),
    "opencode-go": zen("opencode-go", "https://opencode.ai/zen/go/v1"),
    mirror: zen("mirror", "https://gateway.opencode.ai/v1"),
  }

  it.live("get() drops opencode providers from the on-disk catalog", () =>
    Effect.gen(function* () {
      yield* writeCache(mixed)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result)).toEqual(["acme"])
    }),
  )

  it.live("get() drops opencode providers from freshly fetched data", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(mixed) })
      Flag.YUKIOSHI_DISABLE_MODELS_FETCH = false
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      ).pipe(Effect.ensuring(Effect.sync(() => (Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true))))
      expect(Object.keys(result)).toEqual(["acme"])
    }),
  )
})
