// API-key rotation: a provider can list several keys (`options.apiKeys`). Requests use one key; when the
// provider answers with a rate-limit, quota, or sign-in error, that key rests and the request is sent
// again with the next one. The SDK is created with the first key, so the wrapper swaps that key for the
// active one where it is sent (a header such as `Authorization: Bearer <key>` or x-api-key, or a `key=`
// query parameter), which works for every provider without knowing its header names.

const ROTATE_ON = new Set([401, 402, 403, 429])
const DEFAULT_REST_MS = 60_000

type Fetch = (input: any, init?: any) => Promise<Response>

export interface Rotation {
  /** Index of the key requests currently use. */
  readonly active: () => number
  readonly fetch: Fetch
}

/** How long a key rests after a failure: the provider's retry-after when it gives one, else a minute. */
export function restMs(response: Response, now = Date.now()) {
  const header = response.headers.get("retry-after")
  if (!header) return DEFAULT_REST_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(1_000, date - now) : DEFAULT_REST_MS
}

/** Swaps the key only where it is the whole value or follows an auth scheme ("Bearer <key>"). */
function replaceKey(value: string, from: string, to: string) {
  if (!from) return value
  if (value === from) return to
  const space = value.lastIndexOf(" ")
  return space > 0 && value.slice(space + 1) === from ? value.slice(0, space + 1) + to : value
}

function replaceInUrl(href: string, from: string, to: string) {
  if (!from || !href.includes("?")) return href
  const url = new URL(href)
  let changed = false
  url.searchParams.forEach((value, name) => {
    if (value !== from) return
    url.searchParams.set(name, to)
    changed = true
  })
  return changed ? url.href : href
}

export function rotate(keys: readonly string[], base: Fetch, now: () => number = Date.now): Rotation {
  const original = keys[0] ?? ""
  const restingUntil = new Map<number, number>()
  let active = 0

  const nextAvailable = () => {
    for (let step = 1; step <= keys.length; step++) {
      const index = (active + step) % keys.length
      if ((restingUntil.get(index) ?? 0) <= now()) return index
    }
    return undefined
  }

  const withKey = (input: any, init: any, key: string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const swapped = new Headers()
    headers.forEach((value, name) => swapped.set(name, replaceKey(value, original, key)))
    return [replaceInUrl(url, original, key), { ...init, headers: swapped }] as const
  }

  const fetch: Fetch = async (input, init) => {
    // A streamed body cannot be sent twice, so only plain bodies are retried with another key.
    const replayable = init?.body === undefined || typeof init.body === "string" || init.body instanceof Uint8Array
    let tries = 0
    while (true) {
      const [url, request] = withKey(input, init, keys[active] ?? original)
      const response = await base(url, request)
      if (!ROTATE_ON.has(response.status) || !replayable || keys.length < 2) return response
      restingUntil.set(active, now() + restMs(response, now()))
      const next = nextAvailable()
      tries++
      if (next === undefined || tries >= keys.length) return response
      active = next
      await response.body?.cancel().catch(() => {})
    }
  }

  return { active: () => active, fetch }
}

export * as KeyRotation from "./key-rotation"
