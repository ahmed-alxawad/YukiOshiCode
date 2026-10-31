import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@yukioshi/plugin"
import type { Model, Provider } from "@yukioshi/sdk/v2"
import { createKothoraAuthHooks } from "../../src/plugin/kothora"

const originalBaseUrl = process.env.KOTHORA_BASE_URL
const activeServers: Bun.Server<never>[] = []

type StubOptions = {
  models?: (request: Request) => Response
  completions?: (request: Request) => Response
}

/** Local Kothora gateway stub serving the OpenAI-compatible /code/v1 endpoints. */
function startStub(options: StubOptions = {}) {
  const modelHeaders: Record<string, string>[] = []
  const completionHeaders: Record<string, string>[] = []
  const completionBodies: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/code/v1/models") {
        // Headers must be read eagerly: Bun recycles the server Request once this handler returns.
        modelHeaders.push(Object.fromEntries(request.headers.entries()))
        return options.models ? options.models(request) : Response.json({ object: "list", data: tierEntries() })
      }
      if (url.pathname === "/code/v1/chat/completions") {
        completionHeaders.push(Object.fromEntries(request.headers.entries()))
        completionBodies.push(await request.json())
        return options.completions
          ? options.completions(request)
          : Response.json({ id: "cmpl-1", object: "chat.completion", choices: [] })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  activeServers.push(server)
  process.env.KOTHORA_BASE_URL = `http://127.0.0.1:${server.port}`
  return { modelHeaders, completionHeaders, completionBodies }
}

/** The gateway's documented tier list (fast/balanced/expert) plus one unavailable tier. */
function tierEntries() {
  return [
    {
      id: "fast",
      object: "model",
      owned_by: "kothora",
      name: "Fast",
      available: true,
      context_length: 128_000,
      max_output_tokens: 8_192,
    },
    {
      id: "balanced",
      object: "model",
      owned_by: "kothora",
      name: "Balanced",
      available: true,
      context_length: 200_000,
      max_output_tokens: 16_384,
    },
    {
      id: "expert",
      object: "model",
      owned_by: "kothora",
      name: "Expert",
      available: true,
      context_length: 256_000,
      max_output_tokens: 32_768,
    },
    {
      id: "legacy",
      object: "model",
      owned_by: "kothora",
      name: "Legacy",
      available: false,
      context_length: 32_000,
      max_output_tokens: 4_096,
    },
  ]
}

/** A full Model standing in for whatever defaults the provider catalog carries. */
function defaultModel(id: string): Model {
  return {
    id,
    providerID: "kothora",
    name: `Default ${id}`,
    family: "kothora",
    api: { id, url: "https://kothora.com/code/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000, output: 100 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  }
}

function provider(models: Record<string, Model> = { fallback: defaultModel("fallback") }): Provider {
  return {
    id: "kothora",
    name: "Kothora",
    source: "api",
    env: [],
    options: {},
    models,
  }
}

function providerModels(hooks: Hooks) {
  const models = hooks.provider?.models
  if (!models) throw new Error("Kothora provider.models hook is missing")
  return models
}

/** The auth loader takes the auth getter plus the provider entry; tests only need the getter. */
function authLoader(hooks: Hooks) {
  const loader = hooks.auth?.loader
  if (!loader) throw new Error("Kothora auth loader is missing")
  return (getAuth: () => Promise<unknown>) => loader(getAuth as never, provider({}))
}

function apiAuth(key = "kth-token") {
  return { type: "api" as const, key }
}

afterEach(() => {
  for (const server of activeServers.splice(0)) server.stop(true)
  if (originalBaseUrl === undefined) delete process.env.KOTHORA_BASE_URL
  else process.env.KOTHORA_BASE_URL = originalBaseUrl
})

describe("plugin.kothora models", () => {
  test("signed in: maps the gateway tiers with names, context and output limits", async () => {
    const stub = startStub()
    const hooks = await createKothoraAuthHooks()

    const result = await providerModels(hooks)(provider(), { auth: apiAuth() })

    expect(Object.keys(result).sort()).toEqual(["balanced", "expert", "fast"])
    expect(result.fast?.name).toBe("Fast")
    expect(result.balanced?.name).toBe("Balanced")
    expect(result.expert?.name).toBe("Expert")
    expect(result.fast?.limit).toEqual({ context: 128_000, output: 8_192 })
    expect(result.balanced?.limit).toEqual({ context: 200_000, output: 16_384 })
    expect(result.expert?.limit).toEqual({ context: 256_000, output: 32_768 })
    // OpenAI-compatible completion against the gateway root; the SDK appends /chat/completions.
    expect(result.fast?.api).toEqual({
      id: "fast",
      url: `${process.env.KOTHORA_BASE_URL}/code/v1`,
      npm: "@ai-sdk/openai-compatible",
    })
    expect(stub.modelHeaders).toHaveLength(1)
    expect(stub.modelHeaders[0]["authorization"]).toBe("Bearer kth-token")
  })

  test("signed in: tiers the gateway marks unavailable are left out", async () => {
    startStub()
    const hooks = await createKothoraAuthHooks()

    const result = await providerModels(hooks)(provider(), { auth: apiAuth() })

    // The Model type has no availability marker, so unavailable tiers are filtered entirely.
    expect(result.legacy).toBeUndefined()
    expect(Object.keys(result)).not.toContain("legacy")
  })

  test("not signed in: the provider catalog passes through unchanged", async () => {
    const stub = startStub()
    const hooks = await createKothoraAuthHooks()
    const catalog = provider()

    const anonymous = await providerModels(hooks)(catalog, {})
    expect(anonymous).toBe(catalog.models)
    expect(Object.keys(anonymous)).toEqual(["fallback"])

    const nonApi = await providerModels(hooks)(catalog, {
      auth: { type: "oauth", refresh: "r", access: "a", expires: 0 },
    })
    expect(nonApi).toBe(catalog.models)
    expect(stub.modelHeaders).toHaveLength(0)
  })

  test("models endpoint failing falls back to the provider catalog without throwing", async () => {
    startStub({
      models: () => new Response("boom", { status: 500 }),
      completions: () => Response.json({ choices: [] }),
    })
    const hooks = await createKothoraAuthHooks()
    const catalog = provider()

    const result = await providerModels(hooks)(catalog, { auth: apiAuth() })

    expect(result).toBe(catalog.models)
    expect(Object.keys(result)).toEqual(["fallback"])
  })

  test("a malformed models body falls back to the provider catalog", async () => {
    startStub({ models: () => Response.json({ object: "list", data: "not-an-array" }) })
    const hooks = await createKothoraAuthHooks()
    const catalog = provider()

    const result = await providerModels(hooks)(catalog, { auth: apiAuth() })

    expect(result).toBe(catalog.models)
  })

  test("the auth loader's fetch sends the device token as a Bearer header to the gateway", async () => {
    const stub = startStub()
    const hooks = await createKothoraAuthHooks()
    const loader = authLoader(hooks)

    const supplied = await loader(async () => apiAuth())
    expect(supplied.apiKey).toBe("")
    expect(typeof supplied.fetch).toBe("function")

    const response = await supplied.fetch(`${process.env.KOTHORA_BASE_URL}/code/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.ok).toBe(true)

    expect(stub.completionHeaders[0]["authorization"]).toBe("Bearer kth-token")
    expect(stub.completionHeaders[0]["content-type"]).toBe("application/json")
    expect(stub.completionBodies[0]).toEqual({ model: "fast", messages: [{ role: "user", content: "hi" }] })
  })

  test("the auth loader opts out when the stored auth is not api-shaped", async () => {
    const hooks = await createKothoraAuthHooks()
    const loader = authLoader(hooks)

    const withoutAuth = await loader(async () => undefined)
    expect(withoutAuth).toEqual({})

    const oauthAuth = await loader(async () => ({ type: "oauth" as const, refresh: "r", access: "a", expires: 0 }))
    expect(oauthAuth).toEqual({})
  })
})
