/**
 * YukiOshi never sends sessions, prompts or credentials to opencode's servers.
 * Everything that is operated by opencode (Zen, Go, any *.opencode.ai host) is removed from the
 * model catalog and refused at the HTTP boundary.
 */

export const REMOVED_PROVIDER_IDS: readonly string[] = ["opencode", "opencode-zen", "opencode-go"]

export const OPENCODE_DISABLED_MESSAGE =
  "this provider is operated by opencode and is disabled in YukiOshi Code; use another provider"

const OPENCODE_HOSTS = ["opencode.ai", "opncd.ai"]

export function isOpencodeHost(input: unknown): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false
  const raw = (input instanceof URL ? input.href : input).trim()
  if (!raw) return false
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/\.$/, "")
  return OPENCODE_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))
}

export function isRemovedProviderID(id: string): boolean {
  return REMOVED_PROVIDER_IDS.includes(id)
}

/** Resolve the URL of a fetch input (string, URL or Request). */
export function requestUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string")
    return (input as { url: string }).url
  return undefined
}

export class OpencodeHostBlockedError extends Error {
  constructor(url?: string) {
    super(`${OPENCODE_DISABLED_MESSAGE}${url ? ` (blocked request to ${safeHost(url)})` : ""}`)
    this.name = "OpencodeHostBlockedError"
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return "opencode host"
  }
}

/** Throws when the request target is an opencode-operated host. Call before every provider request. */
export function assertNotOpencodeRequest(input: unknown): void {
  const url = requestUrl(input)
  if (url !== undefined && isOpencodeHost(url)) throw new OpencodeHostBlockedError(url)
}

/** Wrap a fetch so requests to opencode hosts are refused before leaving the process. */
export function guardFetch<F extends (input: any, init?: any) => Promise<Response>>(fetchFn: F): F {
  return ((input: any, init?: any) => {
    try {
      assertNotOpencodeRequest(input)
    } catch (error) {
      return Promise.reject(error)
    }
    return fetchFn(input, init)
  }) as F
}

type CatalogProvider = { id?: string; api?: string; models?: Record<string, { provider?: { api?: string } }> }

/**
 * Drop every provider whose id is removed or whose API host (provider-level or any model-level
 * override) is operated by opencode. Returns the same object when nothing was removed.
 */
export function stripOpencodeProviders<T extends Record<string, CatalogProvider>>(catalog: T): T {
  let out: Record<string, CatalogProvider> | undefined
  for (const [key, provider] of Object.entries(catalog)) {
    const hit =
      isRemovedProviderID(key) ||
      (typeof provider?.id === "string" && isRemovedProviderID(provider.id)) ||
      isOpencodeHost(provider?.api) ||
      Object.values(provider?.models ?? {}).some((model) => isOpencodeHost(model?.provider?.api))
    if (!hit) continue
    out ??= { ...catalog }
    delete out[key]
  }
  return (out ?? catalog) as T
}
