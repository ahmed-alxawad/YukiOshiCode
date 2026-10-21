import * as PrivateAddress from "@/tool/webfetch-private"

const MAX_REDIRECTS = 5

/**
 * Only http(s) servers are valid remote MCP endpoints. Other schemes (file:, ftp:, data:, ...)
 * make fetch read local files or talk to something that is not an MCP server at all.
 */
export function remoteUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url
}

/** True when the URL sends credentials in clear text to a host other than this machine. */
export function isCleartextRemote(url: URL): boolean {
  if (url.protocol !== "http:") return false
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return !(host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host))
}

/**
 * A fetch that follows redirects only within the original origin. The platform fetch drops the
 * Authorization header on a cross-origin redirect but forwards every other configured header
 * (API keys, tokens in custom headers), so a remote server could redirect them to a third party.
 */
export function sameOriginFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let current = input instanceof Request ? new URL(input.url) : new URL(String(input))
    const origin = current.origin
    let options: RequestInit = { ...init, redirect: "manual" }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await base(current, options)
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get("location")
      if (!location) return response
      const next = new URL(location, current)
      if (next.origin !== origin)
        throw new Error(`MCP server redirected to a different origin (${next.origin}); refusing to follow it`)
      await response.body?.cancel().catch(() => {})
      current = next
      const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === "POST")
      if (toGet) options = { ...options, method: "GET", body: undefined }
    }
    throw new Error("MCP server redirected too many times")
  }) as typeof fetch
}

/**
 * A fetch that refuses a host resolving to a loopback, private, link-local or reserved address, checked
 * before every request (sameOriginFetch calls it again for each redirect hop), as webfetch and HTTP hooks do.
 */
export function publicOnlyFetch(base: typeof fetch = fetch, resolver?: PrivateAddress.Resolver): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    const target = await PrivateAddress.inspect(url, resolver)
    if (target.risks.length > 0)
      throw new Error(
        `MCP server ${url.host} resolves to ${target.risks.map((risk) => `${risk.address} (${risk.reason})`).join(", ")} ` +
          `and was not contacted. To allow it, add "allowPrivateAddress": true to this server in your global config.`,
      )
    return base(input, init)
  }) as typeof fetch
}

export * as McpGuard from "./guard"
