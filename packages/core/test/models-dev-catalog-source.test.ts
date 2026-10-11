import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNodePlatform } from "@yukioshi/core/effect/app-node-platform"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import { ModelsDev } from "@yukioshi/core/models-dev"
import { tmpdir } from "./fixture/tmpdir"

type Catalog = Record<string, ModelsDev.Provider>

const catalogFixture = {
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
  opencode: {
    id: "opencode",
    name: "OpenCode",
    env: [],
    api: "https://opencode.ai/zen/v1",
    models: {
      "zen-1": {
        id: "zen-1",
        name: "Zen One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128_000, output: 8_192 },
      },
    },
  },
} satisfies Catalog

const snapshotFixture = {
  snapshot: {
    id: "snapshot",
    name: "Bundled Snapshot",
    env: [],
    models: {
      "snapshot-1": {
        id: "snapshot-1",
        name: "Snapshot One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128_000, output: 8_192 },
      },
    },
  },
} satisfies Catalog

const expectedCatalog = { acme: catalogFixture.acme }

const mockHttp = (requests: string[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(catalogFixture)))
      }),
    ),
  )

interface LoadOptions {
  readonly source?: string
  readonly pathCatalog?: Catalog
  readonly snapshot?: Catalog
  readonly disableFetch?: boolean
}

async function loadCatalog(options: LoadOptions = {}) {
  await using cache = await tmpdir()
  const requests: string[] = []
  const modelsPath = path.join(cache.path, "models-dev-catalog.json")
  if (options.pathCatalog !== undefined) await fs.writeFile(modelsPath, JSON.stringify(options.pathCatalog))

  const previousFlags = {
    source: Flag.YUKIOSHI_MODELS_URL,
    path: Flag.YUKIOSHI_MODELS_PATH,
    disableFetch: Flag.YUKIOSHI_DISABLE_MODELS_FETCH,
  }
  const snapshotKey = "YUKIOSHI_MODELS_DEV"
  const previousSnapshot = Object.getOwnPropertyDescriptor(globalThis, snapshotKey)

  try {
    Flag.YUKIOSHI_MODELS_URL = options.source
    Flag.YUKIOSHI_MODELS_PATH = modelsPath
    // Build the layer without its periodic refresh, then select the behavior that get() should exercise.
    Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true
    if (options.snapshot === undefined) Reflect.deleteProperty(globalThis, snapshotKey)
    else Reflect.set(globalThis, snapshotKey, options.snapshot)

    const layer = Layer.fresh(
      AppNodeBuilder.build(ModelsDev.node, [
        [Global.node, Global.layerWith({ cache: cache.path })],
        [LayerNodePlatform.httpClient, mockHttp(requests)],
      ]),
    )
    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        Flag.YUKIOSHI_DISABLE_MODELS_FETCH = options.disableFetch ?? false
        return yield* ModelsDev.Service.use((service) => service.get()).pipe(Effect.provide(context))
      }).pipe(Effect.ensuring(Effect.sync(() => (Flag.YUKIOSHI_DISABLE_MODELS_FETCH = true))), Effect.scoped),
    )

    return { catalog, requests }
  } finally {
    Flag.YUKIOSHI_MODELS_URL = previousFlags.source
    Flag.YUKIOSHI_MODELS_PATH = previousFlags.path
    Flag.YUKIOSHI_DISABLE_MODELS_FETCH = previousFlags.disableFetch
    if (previousSnapshot === undefined) Reflect.deleteProperty(globalThis, snapshotKey)
    else Object.defineProperty(globalThis, snapshotKey, previousSnapshot)
  }
}

describe("ModelsDev catalog source", () => {
  test("loads the models.dev API fixture and strips OpenCode-operated providers", async () => {
    const result = await loadCatalog()

    expect(result.requests).toEqual(["https://models.dev/api.json"])
    expect(result.catalog).toEqual(expectedCatalog)
  })

  test("keeps YUKIOSHI_MODELS_URL as a base URL override", async () => {
    const result = await loadCatalog({ source: "https://catalog.example.test" })

    expect(result.requests).toEqual(["https://catalog.example.test/api.json"])
    expect(result.catalog).toEqual(expectedCatalog)
  })

  test("uses YUKIOSHI_MODELS_PATH before the network", async () => {
    const result = await loadCatalog({ pathCatalog: snapshotFixture, disableFetch: true })

    expect(result.requests).toEqual([])
    expect(result.catalog).toEqual(snapshotFixture)
  })

  test("uses the bundled snapshot when no catalog file is available", async () => {
    const result = await loadCatalog({ snapshot: snapshotFixture, disableFetch: true })

    expect(result.requests).toEqual([])
    expect(result.catalog).toEqual(snapshotFixture)
  })

  test("returns an empty catalog when fetching is disabled and no fallback is available", async () => {
    const result = await loadCatalog({ disableFetch: true })

    expect(result.requests).toEqual([])
    expect(result.catalog).toEqual({})
  })
})
