import { Effect } from "effect"
import { Auth } from "@/auth"
import { PROVIDER_ID } from "./config"

export interface Tokens {
  readonly access: string
  readonly refresh: string
  /** When the access token expires, in milliseconds since the epoch. */
  readonly expires: number
  readonly deviceId?: string
}

/** Where the device tokens live. Saving must never throw away the old pair unless the new one is written. */
export interface TokenStore {
  load(): Promise<Tokens | undefined>
  save(tokens: Tokens): Promise<void>
  clear(): Promise<void>
}

export function memoryTokenStore(initial?: Tokens): TokenStore & { current(): Tokens | undefined } {
  let value = initial
  return {
    current: () => value,
    load: async () => value,
    save: async (tokens) => {
      value = tokens
    },
    clear: async () => {
      value = undefined
    },
  }
}

/** The tokens go into the existing secret store (OS keychain, owner-only file as fallback) as an OAuth entry. */
export function authTokenStore(auth: Auth.Interface): TokenStore {
  return {
    load: async () => {
      const info = await Effect.runPromise(auth.get(PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined)))
      if (!info || info.type !== "oauth") return undefined
      return { access: info.access, refresh: info.refresh, expires: info.expires, deviceId: info.accountId }
    },
    save: (tokens) =>
      Effect.runPromise(
        auth.set(PROVIDER_ID, {
          type: "oauth",
          access: tokens.access,
          refresh: tokens.refresh,
          expires: tokens.expires,
          ...(tokens.deviceId ? { accountId: tokens.deviceId } : {}),
        }),
      ),
    clear: () => Effect.runPromise(auth.remove(PROVIDER_ID)),
  }
}
