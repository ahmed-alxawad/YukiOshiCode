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

const post = (client: KothoraClient, path: string, body: unknown) =>
  client.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Step 1: ask for a user code and the address where the user enters it. */
export async function authorize(client: KothoraClient, input: { clientName: string; platform?: Platform }) {
  const res = await post(client, "/code/device/authorize", {
    client_name: input.clientName,
    platform: input.platform ?? platformName(),
  })
  return (await res.json()) as DeviceAuthorization
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
        if (!noticed) options.onNotice?.(error.message)
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
    `Account: ${info.account.name} <${info.account.email}>`,
    `Plan: ${info.plan}`,
    `Credits: ${info.credits.balance} of ${info.credits.allowance} left, renews on ${info.credits.renews_on}`,
  ].join("\n")
}
