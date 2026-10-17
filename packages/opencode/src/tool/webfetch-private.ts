import { lookup } from "node:dns/promises"
import * as http from "node:http"
import * as https from "node:https"
import { isIP } from "node:net"
import { Readable } from "node:stream"

export interface Address {
  readonly address: string
  readonly family: 4 | 6
}

export interface AddressRisk extends Address {
  readonly reason: string
}

export interface Target {
  readonly url: URL
  readonly hostname: string
  readonly addresses: readonly Address[]
  readonly risks: readonly AddressRisk[]
}

export type Resolver = (hostname: string) => Promise<readonly Address[]>

export const WARNING =
  "This URL resolves to a private or local network address. Fetching it can expose services that are not publicly reachable."

export async function inspect(url: URL, resolver: Resolver = resolve): Promise<Target> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const family = isIP(hostname)
  const addresses = family === 0 ? await resolver(hostname) : [{ address: hostname, family: family as 4 | 6 }]
  const normalized = normalize(addresses)

  if (normalized.length === 0) throw new Error(`No IP addresses were found for ${hostname}`)

  return {
    url,
    hostname,
    addresses: normalized,
    risks: normalized.flatMap((address) => {
      const reason = privateAddressReason(address.address)
      return reason ? [{ ...address, reason }] : []
    }),
  }
}

export function permissionMetadata(target: Target, allowPrivate: boolean) {
  return {
    force_prompt: true,
    refuse_unattended: true,
    allow_private: allowPrivate,
    warning: `${WARNING} Resolved address${target.risks.length === 1 ? "" : "es"}: ${target.risks.map((risk) => `${risk.address} (${risk.reason})`).join(", ")}.`,
    addresses: target.risks.map((risk) => ({ address: risk.address, family: risk.family, reason: risk.reason })),
  }
}

/**
 * Return a fetch implementation that connects only to the IP addresses that
 * were checked by {@link inspect}. This prevents the HTTP stack from doing a
 * second DNS lookup after the safety decision has been made.
 */
export function pinnedFetch(target: Target): typeof globalThis.fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => request(target, input, init), {
    preconnect: globalThis.fetch.preconnect,
  })
}

export function privateAddressReason(address: string): string | undefined {
  const family = isIP(address)
  if (family === 4) return privateIPv4Reason(address)
  if (family === 6) return privateIPv6Reason(address)
  return "invalid IP address"
}

async function resolve(hostname: string): Promise<readonly Address[]> {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }))
}

function normalize(input: readonly Address[]): Address[] {
  const seen = new Set<string>()
  const result: Address[] = []

  for (const item of input) {
    const family = isIP(item.address)
    if (family !== 4 && family !== 6) throw new Error(`Resolver returned a non-IP address: ${item.address}`)
    const address = { address: item.address, family: family as 4 | 6 }
    const key = `${address.family}:${address.address}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(address)
  }

  return result
}

function privateIPv4Reason(address: string): string | undefined {
  const value = ipv4Value(address)
  if (value === undefined) return "invalid IPv4 address"
  if (value === 0) return "unspecified IPv4 address"
  if (value >>> 24 === 127) return "IPv4 loopback address"
  if ((value & 0xffff0000) >>> 0 === 0xa9fe0000) return "IPv4 link-local address"
  if ((value & 0xff000000) === 0x0a000000) return "private IPv4 address"
  if ((value & 0xfff00000) >>> 0 === 0xac100000) return "private IPv4 address"
  if ((value & 0xffff0000) >>> 0 === 0xc0a80000) return "private IPv4 address"
  if ((value & 0xffc00000) === 0x64400000) return "shared IPv4 address"
  return undefined
}

function privateIPv6Reason(address: string): string | undefined {
  const words = ipv6Words(address)
  if (!words) return "invalid IPv6 address"

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  if (mapped) {
    const ipv4 = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`
    const detail = privateIPv4Reason(ipv4)
    return detail ? `IPv4-mapped IPv6 address (${detail})` : "IPv4-mapped IPv6 address"
  }

  if (words.every((word) => word === 0)) return "unspecified IPv6 address"
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "IPv6 loopback address"
  if ((words[0]! & 0xffc0) === 0xfe80) return "IPv6 link-local address"
  if ((words[0]! & 0xfe00) === 0xfc00) return "private IPv6 address"
  if ((words[0]! & 0xffc0) === 0xfec0) return "IPv6 site-local address"

  // IPv4-compatible IPv6 is obsolete, but recognizing it closes the same
  // spelling bypass as an IPv4-mapped address.
  if (words.slice(0, 6).every((word) => word === 0)) {
    const ipv4 = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`
    const detail = privateIPv4Reason(ipv4)
    if (detail) return `IPv4-compatible IPv6 address (${detail})`
  }

  return undefined
}

function ipv4Value(address: string): number | undefined {
  const parts = address.split(".")
  if (parts.length !== 4) return undefined

  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}

function ipv6Words(input: string): number[] | undefined {
  let address = input.toLowerCase()
  const lastColon = address.lastIndexOf(":")
  if (address.includes(".")) {
    const ipv4 = ipv4Value(address.slice(lastColon + 1))
    if (ipv4 === undefined) return undefined
    address = `${address.slice(0, lastColon + 1)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }

  const [left, right, extra] = address.split("::")
  if (extra !== undefined) return undefined
  const before = left ? left.split(":") : []
  const after = right ? right.split(":") : []
  const compressed = address.includes("::")
  const missing = 8 - before.length - after.length
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return undefined

  const parts = compressed ? [...before, ...Array(missing).fill("0"), ...after] : before
  if (parts.length !== 8) return undefined

  const words = parts.map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
    return Number.parseInt(part, 16)
  })
  return words.every((word): word is number => word !== undefined) ? words : undefined
}

function request(target: Target, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const inputUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input
  if (new URL(inputUrl).href !== target.url.href) {
    return Promise.reject(new Error("Webfetch target changed after DNS safety check"))
  }

  const request = input instanceof Request ? input : undefined
  const headers = new Headers(request?.headers)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  const method = init?.method ?? request?.method ?? "GET"
  if (method !== "GET" && method !== "HEAD")
    return Promise.reject(new Error("Pinned webfetch only supports GET and HEAD requests"))

  const client = target.url.protocol === "https:" ? https : http
  return new Promise<Response>((resolve, reject) => {
    const req = client.request(target.url, {
      agent: false,
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(target.addresses),
      method,
      signal: init?.signal ?? undefined,
    })
    req.once("response", (response) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(entry))
      }
      const status = response.statusCode ?? 500
      const body =
        [204, 205, 304].includes(status)
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                response.on("data", (chunk: Buffer | Uint8Array) => {
                  controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
                })
                response.on("end", () => {
                  try {
                    controller.close()
                  } catch {}
                })
                response.on("error", (err) => {
                  try {
                    controller.error(err)
                  } catch {}
                })
              },
              cancel() {
                response.destroy()
                req.destroy()
              },
            })
      resolve(
        new Response(body, {
          headers: responseHeaders,
          status,
          statusText: response.statusMessage ?? "",
        }),
      )
    })
    req.once("error", reject)
    if (init?.signal) {
      if (init.signal.aborted) {
        req.destroy()
        return reject(init.signal.reason)
      }
      init.signal.addEventListener("abort", () => req.destroy(), { once: true })
    }
    req.end()
  })
}

type Lookup = NonNullable<http.RequestOptions["lookup"]>

function pinnedLookup(addresses: readonly Address[]): Lookup {
  return (_hostname, options, callback) => {
    if (options.all)
      return callback(
        null,
        addresses.map((address) => ({ ...address })),
      )
    const first = addresses[0]
    if (!first) return callback(new Error("No checked IP address is available"), "", 0)
    return callback(null, first.address, first.family)
  }
}
