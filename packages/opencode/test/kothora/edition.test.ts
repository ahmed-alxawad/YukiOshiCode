import { describe, expect, test } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { Auth, InMemoryKeychainStore } from "../../src/auth"
import { DEFAULT_API_URL, apiUrl } from "../../src/kothora/config"
import { BYOK_REFUSED } from "../../src/kothora/errors"
import { applyEdition, FALLBACK_MODELS, type ConfigLike } from "../../src/kothora/provider"
import { authTokenStore, memoryTokenStore } from "../../src/kothora/tokens"
import { testEffect } from "../lib/effect"

const kothora = testEffect(LayerNode.compile(Auth.makeNode(new InMemoryKeychainStore(), false)))
const yukioshi = testEffect(LayerNode.compile(Auth.makeNode(new InMemoryKeychainStore(), true)))

describe("kothora edition: no bring-your-own-key", () => {
  kothora.instance("storing a key for another provider is refused with a clear message", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const error = yield* auth.set("anthropic", { type: "api", key: "sk-test" }).pipe(Effect.flip)
      expect(error.message).toBe(BYOK_REFUSED)
      expect(BYOK_REFUSED).toContain("kothora login")
      expect(yield* auth.all()).toEqual({})
    }),
  )

  kothora.instance("the Kothora sign-in round-trips through the secret store", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const store = authTokenStore(auth)
      expect(yield* Effect.promise(() => store.load())).toBeUndefined()
      const tokens = { access: "kca_a", refresh: "kcr_a", expires: 123456, deviceId: "dev-1" }
      yield* Effect.promise(() => store.save(tokens))
      expect(yield* Effect.promise(() => store.load())).toEqual(tokens)
      yield* Effect.promise(() => store.clear())
      expect(yield* Effect.promise(() => store.load())).toBeUndefined()
    }),
  )

  kothora.instance("logout deletes only the Kothora tokens", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const store = authTokenStore(auth)
      yield* Effect.promise(() => store.save({ access: "a", refresh: "r", expires: 1 }))
      yield* Effect.promise(() => store.clear())
      expect(yield* auth.all()).toEqual({})
    }),
  )

  yukioshi.instance("the yukioshi edition still stores keys for any provider", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", { type: "api", key: "sk-test" })
      expect((yield* auth.all())["anthropic"]).toMatchObject({ type: "api", key: "sk-test" })
    }),
  )
})

describe("kothora edition: provider setup", () => {
  const auth = {} as Auth.Interface
  const base = {
    provider: { openai: { options: { apiKey: "sk-x" } }, kothora: {} },
    enabled_providers: ["openai", "anthropic"],
    disabled_providers: ["google"],
    model: "openai/gpt-5",
  }

  test("Kothora is the only provider; other providers in config are ignored and reported", async () => {
    const { config, ignored } = await applyEdition(base, auth, {
      baseUrl: "https://api.test.invalid",
      store: memoryTokenStore(),
      models: async () => [...FALLBACK_MODELS],
    })
    expect(ignored).toEqual(["openai"])
    expect(config.enabled_providers).toEqual(["kothora"])
    expect(config.disabled_providers).toEqual([])
    expect(Object.keys(config.provider!)).toEqual(["kothora"])
    expect(config["model"]).toBe("openai/gpt-5")
    const provider = config.provider!["kothora"] as any
    expect(provider.api).toBe("https://api.test.invalid/code/v1")
    expect(provider.options.baseURL).toBe("https://api.test.invalid/code/v1")
    expect(typeof provider.options.fetch).toBe("function")
  })

  test("models come from GET /code/v1/models; unavailable ones are left out", async () => {
    const { config } = await applyEdition<ConfigLike>({}, auth, {
      baseUrl: "https://api.test.invalid",
      store: memoryTokenStore(),
      models: async () => [
        { id: "fast", name: "Fast", available: true },
        { id: "balanced", name: "Balanced", available: true },
        { id: "expert", name: "Expert", available: false },
      ],
    })
    const models = (config.provider!["kothora"] as any).models
    expect(Object.keys(models)).toEqual(["fast", "balanced"])
    expect(models.fast.name).toBe("Fast")
  })

  test("when the list cannot be fetched (offline or signed out) Fast, Balanced and Expert are offered", async () => {
    const { config } = await applyEdition<ConfigLike>({}, auth, {
      baseUrl: "https://api.test.invalid",
      store: memoryTokenStore(),
      models: async () => {
        throw new Error("offline")
      },
    })
    const models = (config.provider!["kothora"] as any).models
    expect(Object.values(models).map((m: any) => m.name)).toEqual(["Fast", "Balanced", "Expert"])
  })
})

describe("kothora api address", () => {
  test("KOTHORA_API_URL sets the address, with a placeholder default", () => {
    expect(apiUrl({})).toBe("https://api.kothora.invalid")
    expect(DEFAULT_API_URL).toBe("https://api.kothora.invalid")
    expect(apiUrl({ KOTHORA_API_URL: " https://api.example.test/ " })).toBe("https://api.example.test")
    expect(apiUrl({ KOTHORA_API_URL: "" })).toBe(DEFAULT_API_URL)
  })
})
