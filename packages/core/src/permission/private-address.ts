export * as PrivateAddressPermission from "./private-address"

import type { PermissionV1 } from "@yukioshi/schema/permission-v1"

/**
 * Shared helpers for the webfetch private-address protection. The webfetch tool attaches a
 * `private_address` object to the permission ask's metadata when the target resolved to a
 * loopback, private, link-local or otherwise local network address (see
 * packages/opencode/src/tool/webfetch-private.ts). The permission service turns that marker into
 * a prompt that allow rules and auto modes may not answer, and unattended runners use these
 * helpers to refuse the request with an explanation instead of auto-approving it.
 */

/** True when the ask carries the private-address marker. */
export function isPrivateAddressAsk(metadata: PermissionV1.Request["metadata"] | undefined): boolean {
  const marker = metadata?.["private_address"]
  return typeof marker === "object" && marker !== null
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
