import { errorFromResponse, KothoraError, messageFor } from "./errors"
import { backoff, KothoraClient, toTokens, type TokenResponse } from "./client"
import type { Tokens } from "./tokens"

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export type Platform = "windows" | "macos" | "linux" | "other"

export function platformName(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  if (platform === "linux") return "linux"
  return "other"
}

const CONTROL_CHAR_CLASS = /[\x00-\x1f\x7f-\x9f]/
const CONTROL_CHARS_GLOBAL = /[\x00-\x1f\x7f-\x9f]+/g

export function sanitizeForTerminal(value: string) {
  return String(value).replace(CONTROL_CHARS_GLOBAL, "")
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

function sameKothoraDomain(candidateHost: string, apiHost: string) {
  if (candidateHost === apiHost) return true
  const root = apiHost.startsWith("api.") ? apiHost.slice(4) : apiHost
  const labels = root.split(".")
  if (labels.length < 2) return false
  if (labels.length === 2 && labels[1].length === 2 && /^(co|com|org|net|gov|edu|ac)$/.test(labels[0])) return false
  const candidateRoot = candidateHost.replace(/^(app|www)\./, "")
  return candidateRoot === root
}

function invalidAuthorizationResponse(): never {
  throw new KothoraError({
    code: "invalid_authorization_response",
    status: 502,
    message: "Kothora returned an invalid sign-in address.",
  })
}

export function validateDeviceAuthorization(auth: DeviceAuthorization, baseUrl: string): DeviceAuthorization {
  if (!auth || typeof auth !== "object") invalidAuthorizationResponse()
  for (const field of [auth.device_code, auth.user_code, auth.verification_uri, auth.verification_uri_complete]) {
    if (typeof field !== "string" || field.length === 0 || CONTROL_CHAR_CLASS.test(field)) {
      invalidAuthorizationResponse()
    }
  }
  if (!Number.isFinite(auth.expires_in) || auth.expires_in <= 0 || !Number.isFinite(auth.interval) || auth.interval < 0) {
    invalidAuthorizationResponse()
  }

  let base: URL
  let uri: URL
  let complete: URL
  try {
    base = new URL(baseUrl)
    uri = new URL(auth.verification_uri)
    complete = new URL(auth.verification_uri_complete)
  } catch {
    invalidAuthorizationResponse()
  }

  if (uri.username || uri.password || complete.username || complete.password || uri.origin !== complete.origin) {
    invalidAuthorizationResponse()
  }

  if (base.protocol === "https:") {
    if (uri.protocol !== "https:" || !sameKothoraDomain(uri.hostname, base.hostname)) {
      invalidAuthorizationResponse()
    }
  } else if (base.protocol === "http:" && isLoopbackHost(base.hostname)) {
    if ((uri.protocol !== "http:" && uri.protocol !== "https:") || !isLoopbackHost(uri.hostname)) {
      invalidAuthorizationResponse()
    }
  } else {
    invalidAuthorizationResponse()
  }

  return auth
}

const post = (client: KothoraClient, path: string, body: unknown) =>
  client.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Step 1: ask for a user code and the address where the user enters it. */
export async function authorize(client: KothoraClient, input: { clientName: string; platform?: Platform }) {
  const res = await post(client, "/code/device/authorize", {
    client_name: input.clientName,
    platform: input.platform ?? platformName(),
  })
  return validateDeviceAuthorization((await res.json()) as DeviceAuthorization, client.baseUrl)
}

export interface PollOptions {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /** Called for notices that do not end the wait, such as "slow_down" or a full device list. */
  readonly onNotice?: (message: string) => void
  readonly signal?: AbortSignal
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
}

/**
 * Step 2: poll the token endpoint no faster than `interval`. `authorization_pending` keeps waiting,
 * `slow_down` adds 5 seconds, `expired_token`, `access_denied` and other errors stop with a clear message.
 * A network failure waits with backoff and tries again until the sign-in request itself expires.
 */
export async function pollForTokens(
  baseUrl: string,
  auth: Pick<DeviceAuthorization, "device_code" | "expires_in" | "interval">,
  options: PollOptions = {},
): Promise<Tokens> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + auth.expires_in * 1000
  let interval = Math.max(1, auth.interval)
  let failures = 0
  let noticed = false

  for (;;) {
    if (options.signal?.aborted) throw new KothoraError({ code: "aborted", status: 0, message: "Sign-in cancelled." })
    await sleep(interval * 1000)
    if (now() >= deadline) throw new KothoraError({ code: "expired_token", status: 400, message: messageFor("expired_token") })

    let res: Response
    try {
      res = await doFetch(baseUrl + "/code/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "device_code", device_code: auth.device_code }),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      options.onNotice?.("Could not reach Kothora. Still waiting; will try again.")
      await sleep(backoff(failures++, options.baseDelayMs ?? 1000, options.maxDelayMs ?? 30_000))
      continue
    }
    failures = 0

    if (res.ok) return toTokens((await res.json()) as TokenResponse, now())

    const error = await errorFromResponse(res)
    switch (error.code) {
      case "authorization_pending":
        continue
      case "slow_down":
        interval += 5
        options.onNotice?.(`Kothora asked to poll more slowly. Waiting ${interval} seconds between checks.`)
        continue
      case "device_limit":
        // The request stays valid: polling works once a device is signed out.
        if (!noticed) options.onNotice?.(sanitizeForTerminal(error.message))
        noticed = true
        continue
      case "rate_limited":
        await sleep((error.retryAfterSeconds ?? interval) * 1000)
        continue
      default:
        if (error.status >= 500 || error.status === 408) {
          options.onNotice?.("Kothora had a problem. Still waiting; will try again.")
          await sleep(backoff(failures++, options.baseDelayMs ?? 1000, options.maxDelayMs ?? 30_000))
          continue
        }
        throw error
    }
  }
}

export interface Me {
  account: { id: string; email: string; name: string }
  plan: string
  credits: { balance: string; allowance: number; renews_on: string }
  device_id: string
  /** The account's answer mode (English, Bangla, Mixed, Auto). Not in the contract yet: used when the API sends it. */
  answer_mode?: string
}

export const me = (client: KothoraClient) => client.json<Me>("/code/me")

export interface ModelEntry {
  id: string
  name: string
  available: boolean
  /** Not in the contract yet: used when the API sends them. */
  context_length?: number
  max_output_tokens?: number
}

export async function listModels(client: KothoraClient): Promise<ModelEntry[]> {
  const body = await client.json<{ data: ModelEntry[] }>("/code/v1/models")
  return body.data
}

/** What `kothora whoami` prints. */
export function formatMe(info: Me) {
  return [
    `Account: ${sanitizeForTerminal(info.account.name)} <${sanitizeForTerminal(info.account.email)}>`,
    `Plan: ${sanitizeForTerminal(info.plan)}`,
    `Credits: ${sanitizeForTerminal(info.credits.balance)} of ${info.credits.allowance} left, renews on ${sanitizeForTerminal(info.credits.renews_on)}`,
  ].join("\n")
}
