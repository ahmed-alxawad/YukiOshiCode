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

const acme = {
  acme: {
    id: "acme",
    name: "Acme",
    env: [],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 1, output: 1 },
      },
    },
  },
}

// catalog=false is the Kothora edition: no catalogue is read from disk or fetched, even when one is there.
async function run(catalog: boolean) {
  await using cache = await tmpdir()
  const requests: string[] = []
  const modelsPath = path.join(cache.path, "catalog.json")
  await fs.writeFile(modelsPath, JSON.stringify(acme))
  const before = { path: Flag.YUKIOSHI_MODELS_PATH, disable: Flag.YUKIOSHI_DISABLE_MODELS_FETCH }
  try {
    Flag.YUKIOSHI_MODELS_PATH = catalog ? undefined : modelsPath
    Flag.YUKIOSHI_DISABLE_MODELS_FETCH = false
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(acme)))
        }),
      ),
    )
    const layer = Layer.fresh(
      AppNodeBuilder.build(ModelsDev.nodeWith(catalog), [
        [Global.node, Global.layerWith({ cache: cache.path })],
        [LayerNodePlatform.httpClient, http],
      ]),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* ModelsDev.Service.use((service) => Effect.andThen(service.refresh(true), service.get())).pipe(
          Effect.provide(context),
        )
      }).pipe(Effect.scoped),
    )
    await Bun.sleep(50)
    return { result, requests }
  } finally {
    Flag.YUKIOSHI_MODELS_PATH = before.path
    Flag.YUKIOSHI_DISABLE_MODELS_FETCH = before.disable
  }
}

describe("ModelsDev in the Kothora edition", () => {
  test("never fetches models.dev or reads a catalogue: the catalogue is empty and no request is made", async () => {
    const { result, requests } = await run(false)
    expect(result).toEqual({})
    expect(requests).toEqual([])
  })

  test("the yukioshi edition still fetches the catalogue", async () => {
    const { result, requests } = await run(true)
    expect(requests).toContain("https://models.dev/api.json")
    expect(Object.keys(result)).toEqual(["acme"])
  })
})
