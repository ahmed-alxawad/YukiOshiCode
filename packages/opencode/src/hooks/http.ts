import { lookup } from "node:dns/promises"
import * as http from "node:http"
import * as https from "node:https"
import { isIP } from "node:net"
import { isPrivateAddress } from "@yukioshi/core/permission/private-address"
import { Redact } from "@yukioshi/core/redact"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"

/**
 * HTTP hooks: POST the hook's (already masked) JSON to a URL and read the response like a command hook's
 * standard output. Delivery never throws; every failure is an outcome the caller turns into a warning.
 */

export const DEFAULT_TIMEOUT_MS = 5_000
export const MAX_RESPONSE_BYTES = 64 * 1024

export type Hook = ConfigHooksV1.HookHttp

export function isHook(hook: ConfigHooksV1.Hook): hook is Hook {
  return "type" in hook && hook.type === "http"
}

/**
 * Where a hook sends to, safe to show: scheme and host only. Paths, query strings and user info often
 * carry tokens (Slack and Discord webhook URLs are secrets in themselves).
 */
export function describe(url: string) {
  try {
    const parsed = new URL(url)
    return Redact.mask(`${parsed.protocol}//${parsed.host}`)
  } catch {
    return "an invalid URL"
  }
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Header values with $NAME / ${NAME} replaced. Only variables the hook lists in allowedEnvVars are read;
 * any other reference becomes empty, so a hook cannot pull an arbitrary secret out of the environment.
 * Every value read is registered as a secret, so it is masked wherever it would otherwise be shown.
 */
export function expandHeaders(hook: Hook): Record<string, string> {
  const allowed = new Set(hook.allowedEnvVars ?? [])
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(hook.headers ?? {})) {
    const value = raw.replace(ENV_REFERENCE, (_, braced: string | undefined, bare: string | undefined) => {
      const variable = (braced ?? bare)!
      if (!allowed.has(variable)) return ""
      const resolved = process.env[variable] ?? ""
      Redact.registerSecret(resolved)
      return resolved
    })
    Redact.registerSecret(value)
    result[name] = value
  }
  return result
}

export type Outcome =
  | { readonly kind: "response"; readonly body: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "abort" }
  | { readonly kind: "error"; readonly message: string }

export interface PostInput {
  readonly hook: Hook
  /** The masked JSON payload, the same text a command hook gets on standard input. */
  readonly body: string
  /** Whether this hook may reach a private or local address (an opt-in from the global config). */
  readonly allowPrivate: boolean
  readonly signal?: AbortSignal
}

class DeliveryError extends Error {}

type Address = { address: string; family: 4 | 6 }

async function resolve(hostname: string): Promise<Address[]> {
  const family = isIP(hostname)
  if (family !== 0) return [{ address: hostname, family: family as 4 | 6 }]
  const found = await lookup(hostname, { all: true, verbatim: true })
  return found.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }))
}

/** Connect only to the addresses that were checked, so a second DNS answer cannot redirect the request. */
function pinned(addresses: Address[]): NonNullable<http.RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options.all)
      return callback(
        null,
        addresses.map((entry) => ({ ...entry })),
      )
    const first = addresses[0]!
    return callback(null, first.address, first.family)
  }
}

function send(url: URL, addresses: Address[], headers: Record<string, string>, body: string, signal: AbortSignal) {
  return new Promise<string>((done, fail) => {
    const client = url.protocol === "https:" ? https : http
    const request = client.request(url, {
      method: "POST",
      agent: false,
      lookup: pinned(addresses),
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body, "utf8")),
      },
    })
    const stop = () => request.destroy(new DeliveryError("aborted"))
    signal.addEventListener("abort", stop, { once: true })
    request.once("close", () => signal.removeEventListener("abort", stop))
    request.once("error", fail)
    request.once("response", (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        // A redirect is not followed: the configured headers must not reach another URL.
        return fail(
          new DeliveryError(
            `returned status ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""}`,
          ),
        )
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy()
          return fail(new DeliveryError(`response is larger than ${MAX_RESPONSE_BYTES} bytes`))
        }
        chunks.push(chunk)
      })
      response.once("error", fail)
      response.once("end", () => done(Buffer.concat(chunks).toString("utf8")))
    })
    request.end(body)
  })
}

async function deliver(input: PostInput, signal: AbortSignal): Promise<Outcome> {
  let url: URL
  try {
    url = new URL(input.hook.url)
  } catch {
    return { kind: "error", message: "the URL is not valid" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "error", message: "the URL must start with http:// or https://" }
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = await resolve(hostname).catch(() => [] as Address[])
  if (signal.aborted) return { kind: "abort" }
  if (addresses.length === 0) return { kind: "error", message: `could not resolve ${describe(input.hook.url)}` }
  if (!input.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    return {
      kind: "error",
      message:
        `${describe(input.hook.url)} is a private or local network address and was not contacted. ` +
        `To allow it, add "allowPrivateAddress": true to this hook in your global config.`,
    }
  }
  const body = await send(url, addresses, expandHeaders(input.hook), input.body, signal)
  return { kind: "response", body }
}

/** POSTs one hook. Resolves within the hook's timeout (default five seconds) whatever the server does. */
export async function post(input: PostInput): Promise<Outcome> {
  if (input.signal?.aborted) return { kind: "abort" }
  const timeoutMs =
    typeof input.hook.timeoutMs === "number" && input.hook.timeoutMs > 0 ? input.hook.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  // DNS lookups cannot be cancelled, so the timeout and the caller's abort race the whole delivery.
  const stopped = new Promise<Outcome>((done) => {
    timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs)
    onAbort = () => done({ kind: "abort" })
    input.signal?.addEventListener("abort", onAbort, { once: true })
  })
  const delivered = deliver(input, controller.signal).catch(
    (error): Outcome => ({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
  )
  try {
    return await Promise.race([delivered, stopped])
  } finally {
    clearTimeout(timer)
    if (onAbort) input.signal?.removeEventListener("abort", onAbort)
    controller.abort()
  }
}
