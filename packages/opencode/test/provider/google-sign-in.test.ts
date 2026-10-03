import { afterEach, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@yukioshi/core/global"
import { Filesystem } from "@/util/filesystem"
import { Env } from "../../src/env"
import { Provider } from "@/provider/provider"
import { GOOGLE_SIGN_IN_KEY } from "@/plugin/google"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@yukioshi/core/provider"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node])))

const originalEnv = new Map<string, string | undefined>()

const unset = (k: string) =>
  Effect.gen(function* () {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    delete process.env[k]
    yield* Env.use.remove(k)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const withAuthJson = (contents: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authPath = path.join(Global.Path.data, "auth.json")
      const original = await Filesystem.readText(authPath).catch(() => undefined)
      await Filesystem.write(authPath, contents)
      return { authPath, original }
    }),
    ({ authPath, original }) =>
      Effect.promise(async () => {
        if (original !== undefined) return Filesystem.write(authPath, original)
        await unlink(authPath).catch(() => undefined)
      }),
  )

it.instance("Google sign-in for Vertex AI uses the stored project and region, never an API key", () =>
  Effect.gen(function* () {
    for (const key of ["GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"]) {
      yield* unset(key)
    }
    for (const key of ["GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION"]) {
      yield* unset(key)
    }
    yield* withAuthJson(
      JSON.stringify({
        "google-vertex": {
          type: "api",
          key: GOOGLE_SIGN_IN_KEY,
          metadata: { project: "my-project-123", location: "europe-west4" },
        },
      }),
    )

    const vertex = (yield* Provider.use.list())[ProviderV2.ID.googleVertex]
    expect(vertex).toBeDefined()
    expect(vertex.key).toBeUndefined()
    expect(vertex.options.apiKey).toBeUndefined()
    expect(vertex.options.project).toBe("my-project-123")
    expect(vertex.options.location).toBe("europe-west4")
  }),
)
