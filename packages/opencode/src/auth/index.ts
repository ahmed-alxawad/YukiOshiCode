import { LayerNode } from "@yukioshi/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@yukioshi/core/schema"
import { Global } from "@yukioshi/core/global"
import { FSUtil } from "@yukioshi/core/fs-util"
import { createKeychainStore, type KeychainStore } from "./keychain"

export const OAUTH_DUMMY_KEY = "yukioshi-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Auth") {}

export function makeLayer(keychainOverride?: KeychainStore) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const decode = Schema.decodeUnknownOption(Info)
      const keychain = keychainOverride ?? createKeychainStore()

      const isKeychainAvailable = Effect.fn("Auth.isKeychainAvailable")(() =>
        Effect.promise(() => keychain.isAvailable()).pipe(Effect.orElseSucceed(() => false)),
      )

      const readFallbackFile = Effect.fn("Auth.readFallbackFile")(function* () {
        const raw = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
        return Record.filterMap(raw, (value) => Result.fromOption(decode(value), () => undefined))
      })

      const all = Effect.fn("Auth.all")(function* () {
        if (process.env.YUKIOSHI_AUTH_CONTENT) {
          try {
            return JSON.parse(process.env.YUKIOSHI_AUTH_CONTENT)
          } catch (err) {}
        }

        const available = yield* isKeychainAvailable()
        if (available) {
          try {
            const raw = yield* Effect.promise(() => keychain.get("credentials"))
            if (raw) {
              const parsed = JSON.parse(raw) as Record<string, unknown>
              const keychainData = Record.filterMap(parsed, (value) => Result.fromOption(decode(value), () => undefined))

              // Check if legacy auth.json has any entries not yet in keychain (e.g. migration)
              const fallbackData = yield* readFallbackFile()
              let merged = false
              for (const [k, v] of Object.entries(fallbackData)) {
                if (!(k in keychainData)) {
                  keychainData[k] = v
                  merged = true
                }
              }
              if (merged) {
                yield* Effect.promise(() => keychain.set("credentials", JSON.stringify(keychainData))).pipe(
                  Effect.ignore,
                )
              }
              return keychainData
            }

            // Keychain is available but credentials record is empty. Check if pre-existing auth.json exists.
            const fallbackData = yield* readFallbackFile()
            if (Object.keys(fallbackData).length > 0) {
              yield* Effect.promise(() => keychain.set("credentials", JSON.stringify(fallbackData))).pipe(
                Effect.ignore,
              )
              return fallbackData
            }
            return {}
          } catch {
            // Fall back to reading auth.json on unexpected keychain read errors
          }
        }

        return yield* readFallbackFile()
      })

      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        const allData = yield* all()
        if (allData[providerID]) return allData[providerID]

        const available = yield* isKeychainAvailable()
        if (available) {
          try {
            const raw = yield* Effect.promise(() => keychain.get(providerID))
            if (raw) {
              const parsed = JSON.parse(raw)
              const decoded = decode(parsed)
              if (decoded._tag === "Some") return decoded.value
            }
          } catch {}
        }
        return undefined
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        const norm = key.replace(/\/+$/, "")
        const data = yield* all()
        if (norm !== key) delete data[key]
        delete data[norm + "/"]
        data[norm] = info

        const available = yield* isKeychainAvailable()
        if (available) {
          try {
            yield* Effect.promise(() => keychain.set("credentials", JSON.stringify(data)))
            yield* Effect.promise(() => keychain.set(norm, JSON.stringify(info))).pipe(Effect.ignore)

            // Remove plaintext entry from auth.json if present
            const fallbackData = yield* readFallbackFile()
            if (norm in fallbackData || key in fallbackData) {
              delete fallbackData[key]
              delete fallbackData[norm]
              yield* fsys.writeJson(file, fallbackData, 0o600).pipe(Effect.ignore)
            }
            return
          } catch {
            // If keychain write fails, fall through to fallback file write
          }
        }

        yield* fsys
          .writeJson(file, { ...data, [norm]: info }, 0o600)
          .pipe(Effect.mapError(fail("Failed to write auth data")))
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        const norm = key.replace(/\/+$/, "")
        const data = yield* all()
        delete data[key]
        delete data[norm]

        const available = yield* isKeychainAvailable()
        if (available) {
          try {
            yield* Effect.promise(() => keychain.set("credentials", JSON.stringify(data)))
            yield* Effect.promise(() => keychain.delete(norm)).pipe(Effect.ignore)
          } catch {}
        }

        const fallbackData = yield* readFallbackFile()
        if (key in fallbackData || norm in fallbackData) {
          delete fallbackData[key]
          delete fallbackData[norm]
          yield* fsys.writeJson(file, fallbackData, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
        }
      })

      return Service.of({ get, all, set, remove })
    }),
  )
}

export function makeNode(keychain?: KeychainStore) {
  return LayerNode.make({ service: Service, layer: makeLayer(keychain), deps: [FSUtil.node] })
}

export const node = makeNode()

export {
  type KeychainStore,
  createKeychainStore,
  MacKeychainStore,
  SecretServiceStore,
  WindowsDpapiStore,
  InMemoryKeychainStore,
} from "./keychain"

export * as Auth from "."
