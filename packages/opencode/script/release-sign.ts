#!/usr/bin/env bun
// Signs a release SHA256SUMS file with Ed25519 and writes SHA256SUMS.sig (base64) next to it.
// Usage: YUKIOSHI_RELEASE_SIGNING_KEY=<PEM or base64 PKCS8 DER> bun script/release-sign.ts [path/to/SHA256SUMS]
import { createPrivateKey, sign } from "crypto"
import fs from "fs"

const file = process.argv[2] ?? "SHA256SUMS"
const secret = process.env.YUKIOSHI_RELEASE_SIGNING_KEY?.trim()
if (!secret) {
  console.error("YUKIOSHI_RELEASE_SIGNING_KEY is not set")
  process.exit(1)
}
const key = secret.includes("BEGIN")
  ? createPrivateKey(secret)
  : createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" })
const signature = sign(null, fs.readFileSync(file), key)
fs.writeFileSync(`${file}.sig`, signature.toString("base64") + "\n")
console.log(`wrote ${file}.sig`)
