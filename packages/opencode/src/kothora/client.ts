import { randomUUID } from "node:crypto"
import { errorFromResponse, KothoraError, NO_RETRY } from "./errors"
import type { TokenStore, Tokens } from "./tokens"

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  readonly baseUrl: string
  readonly store: TokenStore
  readonly fetch?: Fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly uuid?: () => string
  /** Tries for one call when the network fails or the server answers 5xx (default 5). */
  readonly attempts?: number
  /** First wait between tries; it doubles each time up to `maxDelayMs`. */
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  /** Refresh this long before the access token expires. */
  readonly skewMs?: number
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires_in?: number
  device_id?: string
}

export function toTokens(res: TokenResponse, now: number): Tokens {
  return { access: res.access_token, refresh: res.refresh_token, expires: now + res.expires_in * 1000, deviceId: res.device_id }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Network failures and 5xx answers that are worth another try. Credit and spend stops are not. */
export function retryableStatus(status: number, code?: string) {
  if (code && NO_RETRY.has(code)) return false
  return status === 408 || status >= 500
}

export function backoff(attempt: number, base: number, max: number) {
  return Math.min(max, base * 2 ** attempt)
}

/** Calls the Kothora API as the signed-in device: bearer token, refresh before expiry and on 401, retries. */
export class KothoraClient {
  private readonly doFetch: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly skewMs: number
  private refreshing?: Promise<Tokens>
  /** Set only when saving a refreshed pair failed: the newest pair, kept for this run. */
  private unsaved?: Tokens

  constructor(private readonly options: ClientOptions) {
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
    this.uuid = options.uuid ?? randomUUID
    this.attempts = options.attempts ?? 5
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 15_000
    this.skewMs = options.skewMs ?? 60_000
  }

  private load() {
    return this.unsaved ? Promise.resolve(this.unsaved) : this.options.store.load()
  }

  url(path: string) {
    return this.options.baseUrl + path
  }

  /** The access token to use now, refreshed first when it is about to expire. */
  async accessToken(): Promise<string> {
    const tokens = await this.load()
    if (!tokens) throw new KothoraError({ code: "not_authenticated", status: 401, message: "You are not signed in. Run `kothora login`." })
    if (tokens.expires - this.skewMs > this.now()) return tokens.access
    return (await this.refresh(tokens.access)).access
  }

  /**
   * Exchange the refresh token for a new pair. One refresh at a time (the server signs a device out when a
   * refresh token is used twice), and the stored pair is only replaced once the new one came back.
   */
  refresh(staleAccess?: string): Promise<Tokens> {
    this.refreshing ??= this.doRefresh(staleAccess).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async doRefresh(staleAccess?: string): Promise<Tokens> {
    const stored = await this.load()
    if (!stored) throw new KothoraError({ code: "not_authenticated", status: 401, message: "You are not signed in. Run `kothora login`." })
    // Another process may have refreshed already: use its pair instead of spending the refresh token twice.
    if (staleAccess !== undefined && stored.access !== staleAccess && stored.expires - this.skewMs > this.now()) return stored

    const res = await this.send("/code/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: stored.refresh }),
    })
    const next = toTokens((await res.json()) as TokenResponse, this.now())
    try {
      await this.options.store.save(next)
    } catch (error) {
      // The new refresh token is the only valid one now. Keep it for this run and say so.
      process.stderr.write(`kothora: could not save the refreshed sign-in (${error instanceof Error ? error.message : error}). Keeping it for this session.\n`)
      this.unsaved = next
    }
    return next
  }

  /**
   * One request with the bearer token. A 401 `token_expired` (or any 401 once) triggers one refresh and a
   * second try. Network failures and 5xx answers retry with backoff; the headers, including the
   * Idempotency-Key, are the same on every try.
   */
  async request(path: string, init: RequestInit = {}, extra: { idempotent?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (extra.idempotent && !headers.has("idempotency-key")) headers.set("idempotency-key", this.uuid())
    let token = await this.accessToken()
    let refreshed = false
    for (;;) {
      headers.set("authorization", `Bearer ${token}`)
      try {
        return await this.send(path, { ...init, headers })
      } catch (error) {
        if (error instanceof KothoraError && error.status === 401 && !refreshed && error.code !== "not_authenticated") {
          refreshed = true
          token = (await this.refresh(token)).access
          continue
        }
        throw error
      }
    }
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T
  }

  /** The plain call with retries; resolves only for 2xx answers. */
  async send(path: string, init: RequestInit): Promise<Response> {
    let last: unknown
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await this.sleep(backoff(attempt - 1, this.baseDelayMs, this.maxDelayMs))
      let res: Response
      try {
        res = await this.doFetch(this.url(path), init)
      } catch (error) {
        if (init.signal?.aborted) throw error
        last = error
        continue
      }
      if (res.ok) return res
      const error = await errorFromResponse(res)
      if (!retryableStatus(error.status, error.code)) throw error
      last = error
      if (error.retryAfterSeconds !== undefined) await this.sleep(Math.min(error.retryAfterSeconds * 1000, this.maxDelayMs))
    }
    if (last instanceof KothoraError) throw last
    throw new KothoraError({
      code: "network_error",
      status: 0,
      message: "Could not reach Kothora. Check your connection; your sign-in is kept and nothing was lost.",
    })
  }
}
