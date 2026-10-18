#!/usr/bin/env bun
// Prints a new Ed25519 release-signing keypair.
// - Private key (PEM): store as the secret YUKIOSHI_RELEASE_SIGNING_KEY. Never commit it.
// - Public key (base64 SPKI DER): paste into RELEASE_PUBLIC_KEY in src/installation/release-key.ts.
import { generateKeyPairSync } from "crypto"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
console.log(privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim())
console.log("")
console.log("RELEASE_PUBLIC_KEY (base64):")
console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"))
