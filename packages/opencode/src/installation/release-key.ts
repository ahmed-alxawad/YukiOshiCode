import { createPublicKey, verify } from "crypto"
import semver from "semver"

/**
 * Ed25519 public key that signs release SHA256SUMS files, as base64 of the DER (SPKI) encoding
 * (printed by script/release-keygen.ts). Empty means no key is configured: signatures are not checked.
 */
export const RELEASE_PUBLIC_KEY = "" // [TBD owner: release public key]
/**
 * Owner steps to enable signing (do not edit docs):
 * 1. Run `script/release-keygen.ts` to generate a key pair.
 * 2. Copy the printed public key (base64 DER) into RELEASE_PUBLIC_KEY above.
 * 3. Store the private key as a repository secret (e.g., `RELEASE_PRIVATE_KEY`).
 * 4. In `.github/workflows/release.yml` add a step to run `script/release-sign.ts` using the secret.
 *    (Do NOT commit the private key.)
 */

/**
 * First release version that must carry a valid SHA256SUMS.sig when a key is configured. Releases
 * older than this may be unsigned (with a warning). undefined means no release requires a signature yet.
 */
export const SIGNING_REQUIRED_FROM: string | undefined = undefined

/** Accepts a raw 64-byte signature or its base64 text. */
export function decodeSignature(data: Uint8Array) {
  if (data.length === 64) return Buffer.from(data)
  const text = Buffer.from(data).toString("utf8").trim()
  const decoded = Buffer.from(text, "base64")
  return decoded.length === 64 ? decoded : undefined
}

export type SignatureCheck = "skipped" | "valid" | "unsigned-allowed"

/**
 * Checks SHA256SUMS against its signature. Throws Error with a user-facing message when the update must
 * be refused. `signature` is undefined when the release has no SHA256SUMS.sig.
 */
export function checkSums(input: {
  sums: Uint8Array
  signature?: Uint8Array
  version: string
  key?: string
  requiredFrom?: string
}): SignatureCheck {
  const key = input.key ?? RELEASE_PUBLIC_KEY
  if (!key) return "skipped"
  if (!input.signature) {
    const requiredFrom = input.requiredFrom ?? SIGNING_REQUIRED_FROM
    if (requiredFrom && semver.gte(input.version, requiredFrom))
      throw new Error(`the release has no SHA256SUMS.sig, and releases from ${requiredFrom} on must be signed`)
    return "unsigned-allowed"
  }
  const signature = decodeSignature(input.signature)
  let ok = false
  try {
    ok =
      !!signature &&
      verify(null, input.sums, createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), signature)
  } catch {}
  if (!ok) throw new Error("the signature of SHA256SUMS is not valid for this release; refusing to update")
  return "valid"
}
