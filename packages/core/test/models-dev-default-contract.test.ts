import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNodePlatform } from "@yukioshi/core/effect/app-node-platform"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import { ModelsDev } from "@yukioshi/core/models-dev"
import { Flock } from "@yukioshi/core/util/flock"
import { tmpdir } from "./fixture/tmpdir"

const modelsDevApiFixture = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    api: "https://api.acme.test/v1",
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128_000, output: 8_192 },
      },
    },
  },
} satisfies Record<string, ModelsDev.Provider>

const modelsDevApiText = JSON.stringify(modelsDevApiFixture)
const historicalCatalogFixture = new URL("../../opencode/test/tool/fixtures/models-api.json", import.meta.url)

function expectProviderIdsAsTopLevelKeys(catalog: Record<string, { id: string }>) {
  for (const [id, provider] of Object.entries(catalog)) expect(provider.id).toBe(id)
}

function buildLayer(cache: string, requests: string[], rejectRequests: boolean) {
  return Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [Global.node, Global.layerWith({ cache })],
      [
        LayerNodePlatform.httpClient,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request.url)
              if (rejectRequests) throw new Error("the cache read must not make an HTTP request")
              return HttpClientResponse.fromWeb(request, new Response(modelsDevApiText))
            }),
          ),
        ),
      ],
    ]),
  )
}

async function loadCatalog(cache: string, requests: string[], fetch: boolean) {
  // Build while fetching is disabled so the periodic refresh never starts; enable
  // only the explicit get() below when this call is intended to populate the cache.
  Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true
  const layer = buildLayer(cache, requests, !fetch)
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      Flag.YUKIOSHI_DISABLE_MODELS_FETCH = !fetch
      return yield* ModelsDev.Service.use((service) => service.get()).pipe(Effect.provide(context))
    }).pipe(Effect.ensuring(Effect.sync(() => (Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true))), Effect.scoped),
  )
}

describe("ModelsDev default catalog contract", () => {
  test("uses the provider-id map shape shared with the historical OpenCode-host catalog fixture", async () => {
    const decodeCatalog = Schema.decodeUnknownSync(Schema.Record(Schema.String, ModelsDev.Provider))
    const catalog = decodeCatalog(modelsDevApiFixture)
    const historical = (await Bun.file(historicalCatalogFixture).json()) as Record<string, { id: string }>

    expect(catalog).toEqual(modelsDevApiFixture)
    expectProviderIdsAsTopLevelKeys(catalog)
    expect(historical).toHaveProperty("opencode")
    expect(historical).toHaveProperty("opencode-go")
    expectProviderIdsAsTopLevelKeys(historical)
  })

  test("fetches models.dev and then reads its default models.json cache without HTTP", async () => {
    await using cache = await tmpdir()
    const previousFlags = {
      source: Flag.YUKIOSHI_MODELS_URL,
      path: Flag.YUKIOSHI_MODELS_PATH,
      disableFetch: Flag.YUKIOSHI_DISABLE_MODELS_FETCH,
    }
    const previousPaths = { cache: Global.Path.cache, state: Global.Path.state }
    const snapshotKey = "YUKIOSHI_MODELS_DEV"
    const previousSnapshot = Object.getOwnPropertyDescriptor(globalThis, snapshotKey)

    try {
      Flag.YUKIOSHI_MODELS_URL = undefined
      Flag.YUKIOSHI_MODELS_PATH = undefined
      Reflect.deleteProperty(globalThis, snapshotKey)
      Global.Path.cache = cache.path
      Global.Path.state = cache.path
      Flock.setGlobal({ state: cache.path })

      const fetchRequests: string[] = []
      const fetched = await loadCatalog(cache.path, fetchRequests, true)
      const cacheFile = path.join(cache.path, "models.json")

      expect(fetched).toEqual(modelsDevApiFixture)
      expect(fetchRequests).toEqual(["https://models.dev/api.json"])
      expect(await fs.readFile(cacheFile, "utf8")).toBe(modelsDevApiText)

      const cacheRequests: string[] = []
      const cached = await loadCatalog(cache.path, cacheRequests, false)

      expect(cached).toEqual(modelsDevApiFixture)
      expect(cacheRequests).toEqual([])
    } finally {
      Flag.YUKIOSHI_MODELS_URL = previousFlags.source
      Flag.YUKIOSHI_MODELS_PATH = previousFlags.path
      Flag.YUKIOSHI_DISABLE_MODELS_FETCH = previousFlags.disableFetch
      Global.Path.cache = previousPaths.cache
      Global.Path.state = previousPaths.state
      Flock.setGlobal({ state: previousPaths.state })
      if (previousSnapshot === undefined) Reflect.deleteProperty(globalThis, snapshotKey)
      else Object.defineProperty(globalThis, snapshotKey, previousSnapshot)
    }
  })
})
