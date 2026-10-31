import type { Hooks, PluginInput } from "@yukioshi/plugin"
import type { Model } from "@yukioshi/sdk/v2"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { setTimeout as sleep } from "node:timers/promises"

// Kothora Code device-code sign-in (RFC 8628). YukiOshi never opens a browser for it: it shows the
// verification URL and the user code, the user approves on any device, and this plugin polls the
// Kothora backend until the token is issued, the request is rejected, or it expires.
//
// Kothora models are gateway-only: after device sign-in the model catalog comes from the gateway's
// OpenAI-compatible /code/v1 endpoints and model calls go to /code/v1/chat/completions, both
// authenticated with the device access token. It holds no secrets - nothing in this repo does.

/** Kothora backend. KOTHORA_BASE_URL overrides it for self-hosted or test deployments. */
const DEFAULT_BASE_URL = "https://kothora.com"
/** Sign-in and token requests must not wait forever on a server that never answers. */
const REQUEST_TIMEOUT_MS = 30_000
/** The model catalog fetch mirrors the copilot plugin's short timeout: a slow catalog must never stall the picker. */
const MODELS_TIMEOUT_MS = 5_000
/** OpenAI-compatible gateway root: /code/v1/models and /code/v1/chat/completions live under it. */
const GATEWAY_API_PATH = "/code/v1"
/** RFC 8628 section 3.5: after slow_down the polling interval grows by 5 seconds. */
const SLOW_DOWN_INCREMENT_S = 5
/** Used when the backend does not send an expires_in. */
const DEFAULT_EXPIRES_IN_S = 600
/** Safety net so a misbehaving backend cannot keep the poll loop alive forever. */
const MAX_POLLS = 1000

const CLIENT_NAME = "YukiOshi"

type DeviceAuthorization = {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

type DeviceToken = {
  access_token?: string
  error?: string
}

type Sleep = (ms: number) => Promise<unknown>

/** One entry of the gateway's GET /code/v1/models response. */
type GatewayModel = {
  id?: string
  object?: string
  owned_by?: string
  name?: string
  available?: boolean
  context_length?: number
  max_output_tokens?: number
}

type GatewayModelsResponse = {
  object?: string
  data?: GatewayModel[]
}

function kothoraBaseUrl() {
  return process.env.KOTHORA_BASE_URL ?? DEFAULT_BASE_URL
}

function gatewayApiUrl() {
  return `${kothoraBaseUrl()}${GATEWAY_API_PATH}`
}

/**
 * Map a gateway model entry onto a Model: OpenAI-compatible completion against the gateway root
 * (the AI SDK appends /chat/completions to api.url), sized by the gateway's context and output
 * limits. Same shape the digitalocean router models use.
 */
function gatewayModel(entry: GatewayModel, id: string): Model {
  return {
    id,
    providerID: "kothora",
    name: typeof entry.name === "string" && entry.name !== "" ? entry.name : id,
    family: "kothora",
    api: { id, url: gatewayApiUrl(), npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : 0,
      output: typeof entry.max_output_tokens === "number" && entry.max_output_tokens > 0 ? entry.max_output_tokens : 0,
    },
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

/**
 * Kothora sign-in with the sleep injectable, so tests can observe the polling rhythm without
 * waiting for it. KothoraAuthPlugin is the real entry point; this factory exists for tests.
 */
export function createKothoraAuthHooks(options: { sleep?: Sleep } = {}): Hooks {
  const doSleep = options.sleep ?? ((ms: number) => sleep(ms))
  // Last gateway catalog this session fetched, kept in plugin scope like the copilot plugin's
  // `let models` so other hooks can consult it without refetching.
  let models: Record<string, Model> = {}
  return {
    provider: {
      id: "kothora",
      async models(provider, ctx) {
        // Device sign-in stores the access token as the key, which persists as api auth.
        if (ctx.auth?.type !== "api") {
          models = {}
          return provider.models
        }

        try {
          const response = await fetch(`${gatewayApiUrl()}/models`, {
            headers: {
              Authorization: `Bearer ${ctx.auth.key}`,
              "User-Agent": `yukioshi/${InstallationVersion}`,
            },
            signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
          })
          if (!response.ok) return provider.models
          const body = (await response.json().catch(() => undefined)) as GatewayModelsResponse | undefined
          const data = Array.isArray(body?.data) ? body.data : []
          const next: Record<string, Model> = {}
          for (const entry of data) {
            if (typeof entry?.id !== "string" || entry.id === "") continue
            // The Model type has no availability marker, so tiers the gateway marks unavailable
            // are left out of the picker entirely.
            if (entry.available === false) continue
            next[entry.id] = gatewayModel(entry, entry.id)
          }
          // An empty catalog would strand the edition; keep whatever defaults exist instead.
          if (Object.keys(next).length === 0) return provider.models
          models = next
          return next
        } catch {
          // A failed catalog fetch must never throw the picker into a bad state.
          return provider.models
        }
      },
    },
    auth: {
      provider: "kothora",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "api") return {}

        return {
          // Placeholder so the SDK does not bail on a missing credential; the real Bearer token
          // is injected by the fetch wrapper below on every call.
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "api") return fetch(request, init)

            // Copy the caller's headers into a fresh Headers (case-insensitive) so the caller's
            // RequestInit is never mutated and any stale authorization is overwritten in one set.
            const headers = new Headers(request instanceof Request ? request.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            headers.set("authorization", `Bearer ${info.key}`)
            headers.set("User-Agent", `yukioshi/${InstallationVersion}`)

            return fetch(request, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Sign in to Kothora (device code)",
          authorize: async () => {
            const base = kothoraBaseUrl()
            const response = await fetch(`${base}/code/device/authorize`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": `yukioshi/${InstallationVersion}` },
              body: JSON.stringify({ client_name: CLIENT_NAME, platform: process.platform }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (!response.ok) throw new Error("Failed to start the Kothora device sign-in")
            const device = (await response.json()) as DeviceAuthorization
            if (!device.device_code || !device.user_code || !device.verification_uri) {
              throw new Error("Kothora sent an incomplete device sign-in response")
            }
            const interval = typeof device.interval === "number" && device.interval >= 0 ? device.interval : 5
            const expiresIn =
              typeof device.expires_in === "number" && device.expires_in > 0 ? device.expires_in : DEFAULT_EXPIRES_IN_S
            const expiresAt = Date.now() + expiresIn * 1000

            return {
              url: device.verification_uri,
              instructions: `Open ${device.verification_uri} on any device, sign in, and approve this request with the code ${device.user_code}. This window keeps waiting until you approve, reject, or the request expires.`,
              method: "auto" as const,
              callback: async () => {
                let intervalSeconds = interval
                for (let poll = 0; poll < MAX_POLLS && Date.now() < expiresAt; poll++) {
                  const tokenResponse = await fetch(`${base}/code/device/token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "User-Agent": `yukioshi/${InstallationVersion}` },
                    body: JSON.stringify({ device_code: device.device_code }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                  }).catch(() => undefined)

                  if (!tokenResponse) {
                    // One unreachable poll is not a failed sign-in: the backend may hiccup while the user approves.
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }

                  const token = (await tokenResponse.json().catch(() => undefined)) as DeviceToken | undefined
                  if (tokenResponse.ok && token?.access_token) {
                    return { type: "success" as const, key: token.access_token }
                  }

                  if (token?.error === "authorization_pending") {
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }
                  if (token?.error === "slow_down") {
                    intervalSeconds += SLOW_DOWN_INCREMENT_S
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }
                  // expired_token, rejected, the device limit (403) and anything unknown cannot recover.
                  return { type: "failed" as const }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
  }
}

/** Kothora through device-code sign-in (RFC 8628). */
export async function KothoraAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createKothoraAuthHooks()
}
