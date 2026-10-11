export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@yukioshi/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"
import crypto from "node:crypto"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@yukioshi/ServerAuthConfig", {
  password: EffectConfig.string("YUKIOSHI_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("YUKIOSHI_SERVER_USERNAME").pipe(EffectConfig.withDefault("yukioshi")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Hash both sides so the comparison time does not depend on where (or whether) the inputs differ.
function safeEqual(a: string, b: string) {
  const left = crypto.createHash("sha256").update(a, "utf8").digest()
  const right = crypto.createHash("sha256").update(b, "utf8").digest()
  return crypto.timingSafeEqual(left, right)
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (!Option.isSome(config.password)) return false
  // Evaluate comparisons in constant time:
  // accept config.username, and also accept legacy "opencode" when default username is used
  const matchConfig = safeEqual(credentials.username, config.username)
  if (config.username === "yukioshi") {
    const matchLegacy = safeEqual(credentials.username, "opencode")
    const username = matchConfig || matchLegacy
    const password = safeEqual(Redacted.value(credentials.password), config.password.value)
    return username && password
  }
  const password = safeEqual(Redacted.value(credentials.password), config.password.value)
  return matchConfig && password
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.YUKIOSHI_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.YUKIOSHI_SERVER_USERNAME ?? "yukioshi"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
