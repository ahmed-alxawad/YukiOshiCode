import { Auth } from "@/auth"
import { KothoraClient } from "./client"
import { apiUrl, PROVIDER_ID } from "./config"
import { listModels, type ModelEntry } from "./device"
import { KothoraError } from "./errors"
import { authTokenStore, type TokenStore } from "./tokens"

/** The three models of the Kothora API. Used when the list cannot be fetched (offline, signed out). */
export const FALLBACK_MODELS: readonly ModelEntry[] = [
  { id: "fast", name: "Fast", available: true },
  { id: "balanced", name: "Balanced", available: true },
  { id: "expert", name: "Expert", available: true },
]

// The API contract gives no context or output sizes. These are placeholders until it does.
const CONTEXT = 128_000
const OUTPUT = 16_000

let shared: { baseUrl: string; client: KothoraClient } | undefined

/** One client per process, so only one refresh runs at a time even when several projects are open. */
export function clientFor(store: TokenStore, baseUrl = apiUrl()) {
  if (!shared || shared.baseUrl !== baseUrl) shared = { baseUrl, client: new KothoraClient({ baseUrl, store }) }
  return shared.client
}

export function resetSharedClient() {
  shared = undefined
}

/**
 * The `fetch` handed to the model SDK. It adds the bearer token and an Idempotency-Key (one UUID per
 * logical request, kept across retries) and never sends the token to any address but the Kothora API.
 * Failures become `KothoraError`s with plain-language messages.
 */
export function providerFetch(client: KothoraClient, baseUrl: string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!target.startsWith(baseUrl + "/"))
      throw new KothoraError({ code: "wrong_host", status: 0, message: "Kothora Code only sends requests to the Kothora API." })
    return client.request(target.slice(baseUrl.length), init, { idempotent: true })
  }
}

export interface ConfigLike {
  provider?: Record<string, unknown>
  enabled_providers?: string[]
  disabled_providers?: string[]
  [key: string]: unknown
}

/**
 * The Kothora edition's provider setup: Kothora is the only provider. Providers from config, environment
 * keys and stored API keys are dropped. The model list comes from GET /code/v1/models.
 */
export async function applyEdition<T extends ConfigLike>(
  cfg: T,
  auth: Auth.Interface,
  options: { store?: TokenStore; baseUrl?: string; models?: (client: KothoraClient) => Promise<ModelEntry[]> } = {},
): Promise<{ config: T; ignored: string[] }> {
  const baseUrl = options.baseUrl ?? apiUrl()
  const store = options.store ?? authTokenStore(auth)
  const client = options.baseUrl ? new KothoraClient({ baseUrl, store }) : clientFor(store, baseUrl)
  const entries = await (options.models ?? ((c) => listModels(c)))(client).catch(() => [...FALLBACK_MODELS])
  const available = entries.filter((item) => item.available)
  const models = Object.fromEntries(
    (available.length ? available : FALLBACK_MODELS).map((item) => [
      item.id,
      { name: item.name, tool_call: true, temperature: true, limit: { context: CONTEXT, output: OUTPUT } },
    ]),
  )
  const { provider, ...rest } = cfg
  return {
    ignored: Object.keys(provider ?? {}).filter((id) => id !== PROVIDER_ID),
    config: {
      ...rest,
      enabled_providers: [PROVIDER_ID],
      disabled_providers: [],
      provider: {
        [PROVIDER_ID]: {
          name: "Kothora",
          npm: "@ai-sdk/openai-compatible",
          api: `${baseUrl}/code/v1`,
          env: [],
          options: {
            baseURL: `${baseUrl}/code/v1`,
            apiKey: "kothora-device-token",
            fetch: providerFetch(client, baseUrl),
          },
          models,
        },
      },
    } as unknown as T,
  }
}
