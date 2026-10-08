import { Context } from "effect"

const trustedWebOrigins = [
  /^https:\/\/([a-z0-9-]+\.)*yukioshi\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/,
] as const

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@yukioshi/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (trustedWebOrigins.some((pattern) => pattern.test(input))) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const LOOPBACK_BIND = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/

export function isLoopbackBind(hostname: string | undefined) {
  return !!hostname && LOOPBACK_BIND.test(hostname.toLowerCase())
}

// Host header allow-list for servers bound to loopback. A DNS-rebinding page is served from an
// attacker-controlled name that resolves to 127.0.0.1, so its requests carry that name in Host.
// Loopback names, IP literals and explicitly configured origins are the only legitimate values.
export function isAllowedHost(host: string | undefined, opts?: CorsOptions) {
  if (!host) return true
  let name: string
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return false
  }
  if (name === "localhost" || name.endsWith(".localhost")) return true
  if (name.startsWith("[")) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true
  return (opts?.cors ?? []).some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === name
    } catch {
      return false
    }
  })
}
