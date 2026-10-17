export * as PrivateAddressPermission from "./private-address"

import { isIP } from "node:net"
import type { PermissionV1 } from "@yukioshi/schema/permission-v1"

/**
 * Shared helpers for the webfetch private-address protection. The webfetch tool attaches a
 * `private_address` object to the permission ask's metadata when the target resolved to a
 * loopback, private, link-local or otherwise local network address (see
 * packages/opencode/src/tool/webfetch-private.ts). The permission service turns that marker into
 * a prompt that allow rules and auto modes may not answer, and unattended runners use these
 * helpers to refuse the request with an explanation instead of auto-approving it.
 */

/** True when the ask carries the private-address marker and private addresses are not allowed. */
export function isPrivateAddressAsk(metadata: PermissionV1.Request["metadata"] | undefined): boolean {
  const marker = metadata?.["private_address"] as { allow_private?: boolean } | undefined
  return typeof marker === "object" && marker !== null && marker.allow_private !== true
}

function privateAddresses(metadata: PermissionV1.Request["metadata"] | undefined): string {
  const marker = metadata?.["private_address"] as { addresses?: ReadonlyArray<{ address?: unknown }> } | undefined
  const addresses = Array.isArray(marker?.addresses)
    ? marker.addresses.filter((item) => typeof item?.address === "string").map((item) => item.address as string)
    : []
  return addresses.length > 0 ? addresses.join(", ") : "a private or local address"
}

/** The feedback an unattended runner sends back when it refuses a private-address webfetch. */
export function refusalText(request: Pick<PermissionV1.Request, "patterns" | "metadata">): string {
  return (
    `webfetch of ${request.patterns.join(", ")} was refused: it resolves to ${privateAddresses(request.metadata)}. ` +
    "Unattended runs have no one to approve a private-network fetch, so it is refused before connecting. " +
    'To allow private fetches for yourself, set "webfetch": { "allow_private": true } in the global config ' +
    "(~/.config/yukioshi/yukioshi.json); otherwise fetch a public URL."
  )
}

/**
 * The single private-address classifier shared by webfetch and HTTP hooks. Returns why an IP
 * address is private, local, multicast or reserved, or undefined for a public address. Anything
 * that is not a valid IP address is refused. IPv4-mapped IPv6 addresses are always refused.
 */
export function privateAddressReason(address: string): string | undefined {
  const family = isIP(address)
  if (family === 4) return privateIPv4Reason(address)
  if (family === 6) return privateIPv6Reason(address)
  return "invalid IP address"
}

export function isPrivateAddress(address: string): boolean {
  return privateAddressReason(address) !== undefined
}

function privateIPv4Reason(address: string): string | undefined {
  const value = ipv4Value(address)
  if (value === undefined) return "invalid IPv4 address"
  if (value >>> 24 === 0) return value === 0 ? "unspecified IPv4 address" : "this-network IPv4 address"
  if (value >>> 24 === 127) return "IPv4 loopback address"
  if ((value & 0xffff0000) >>> 0 === 0xa9fe0000) return "IPv4 link-local address"
  if ((value & 0xff000000) === 0x0a000000) return "private IPv4 address"
  if ((value & 0xfff00000) >>> 0 === 0xac100000) return "private IPv4 address"
  if ((value & 0xffff0000) >>> 0 === 0xc0a80000) return "private IPv4 address"
  if ((value & 0xffc00000) === 0x64400000) return "shared IPv4 address"
  if ((value & 0xffffff00) >>> 0 === 0xc0000000) return "IETF protocol assignment IPv4 address"
  if ((value & 0xfffe0000) >>> 0 === 0xc6120000) return "benchmarking IPv4 address"
  if (value >>> 28 === 0xe) return "IPv4 multicast address"
  if (value >>> 28 === 0xf) return "reserved IPv4 address"
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

  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address that a gateway connects to, so a
  // private IPv4 hidden in them is refused like any other spelling of that address.
  const embedded =
    words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)
      ? { name: "NAT64", high: words[6]!, low: words[7]! }
      : words[0] === 0x2002
        ? { name: "6to4", high: words[1]!, low: words[2]! }
        : undefined
  if (embedded) {
    const ipv4 = `${embedded.high >>> 8}.${embedded.high & 0xff}.${embedded.low >>> 8}.${embedded.low & 0xff}`
    const detail = privateIPv4Reason(ipv4)
    if (detail) return `${embedded.name} IPv6 address embedding a private IPv4 address (${detail})`
  }

  // Teredo (2001::/32) tunnels to an obfuscated IPv4 address, so it cannot be checked and is refused.
  if (words[0] === 0x2001 && words[1] === 0) return "Teredo IPv6 address"

  if (words.every((word) => word === 0)) return "unspecified IPv6 address"
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "IPv6 loopback address"
  if ((words[0]! & 0xffc0) === 0xfe80) return "IPv6 link-local address"
  if ((words[0]! & 0xfe00) === 0xfc00) return "private IPv6 address"
  if ((words[0]! & 0xffc0) === 0xfec0) return "IPv6 site-local address"
  if ((words[0]! & 0xff00) === 0xff00) return "IPv6 multicast address"

  // IPv4-compatible IPv6 (::/96) is obsolete; every address in it is refused, so it
  // cannot be used as a spelling bypass of an IPv4 address.
  if (words.slice(0, 6).every((word) => word === 0)) {
    const ipv4 = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`
    const detail = privateIPv4Reason(ipv4)
    return detail ? `IPv4-compatible IPv6 address (${detail})` : "IPv4-compatible IPv6 address"
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
