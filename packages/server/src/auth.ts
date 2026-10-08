export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import crypto from "node:crypto"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@yukioshi/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("YUKIOSHI_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.string("YUKIOSHI_SERVER_USERNAME").pipe(EffectConfig.withDefault("yukioshi")),
          }),
        )
      }),
    )
  }
}

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
  // Evaluate both comparisons so a wrong username is not distinguishable from a wrong password by timing.
  const username = safeEqual(credentials.username, config.username)
  const password = safeEqual(Redacted.value(credentials.password), config.password.value)
  return username && password
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.YUKIOSHI_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.YUKIOSHI_SERVER_USERNAME ?? "yukioshi"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
