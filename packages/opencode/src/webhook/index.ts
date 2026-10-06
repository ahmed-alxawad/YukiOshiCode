import { createHmac } from "node:crypto"
import { ConfigWebhookV1 } from "@yukioshi/core/v1/config/webhook"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Layer, Context, Scope } from "effect"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

export type WebhookEvent = ConfigWebhookV1.Event

export type WebhookPayload = {
  event: WebhookEvent
  time: string
  session: { id: string; title: string }
  project: { directory: string }
  detail?: Record<string, unknown>
}

const ALL_EVENTS: readonly WebhookEvent[] = [
  "turn.finished",
  "turn.failed",
  "permission.asked",
  "question.asked",
]

const RETRIES = 2
const TIMEOUT_MS = 10_000

export type DeliveryOptions = {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export function webhookWants(config: ConfigWebhookV1.Info, event: WebhookEvent) {
  return (config.events ?? ALL_EVENTS).includes(event)
}

export function webhookBody(payload: WebhookPayload) {
  return JSON.stringify(payload)
}

export function webhookSignature(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

async function fetchOnce(config: ConfigWebhookV1.Info, body: string, attempt: number, options: DeliveryOptions) {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(config.url)
  } catch {
    throw new WebhookDeliveryError(`Invalid webhook URL: ${config.url}`, false)
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new WebhookDeliveryError(`Webhook URL must be http: or https:, got: ${parsedUrl.protocol}`, false)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
  try {
    let currentUrl = parsedUrl
    let redirectCount = 0
    const maxRedirects = 5

    while (true) {
      const isOriginalHost = currentUrl.host === parsedUrl.host
      const headers = {
        "content-type": "application/json",
        ...(isOriginalHost ? (config.headers ?? {}) : {}),
        ...(isOriginalHost && config.secret
          ? { "X-YukiOshi-Signature": webhookSignature(body, config.secret) }
          : {}),
      }
      const response = await (options.fetch ?? globalThis.fetch)(currentUrl.toString(), {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      })

      if (response.status >= 301 && response.status <= 308) {
        const location = response.headers.get("location")
        await response.body?.cancel().catch(() => {})
        if (!location) {
          throw new WebhookDeliveryError(`HTTP ${response.status} redirect without location header`, false)
        }
        redirectCount++
        if (redirectCount > maxRedirects) {
          throw new WebhookDeliveryError(`Too many redirects (max ${maxRedirects})`, false)
        }
        const nextUrl = new URL(location, currentUrl)
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new WebhookDeliveryError(`Redirect URL must be http: or https:, got: ${nextUrl.protocol}`, false)
        }
        if (nextUrl.host !== parsedUrl.host) {
          throw new WebhookDeliveryError(
            `Refusing to follow redirect to different host "${nextUrl.host}" with webhook signature`,
            false,
          )
        }
        currentUrl = nextUrl
        continue
      }

      await response.body?.cancel().catch(() => {})

      if (response.ok) return
      if (response.status >= 400 && response.status < 500) {
        throw new WebhookDeliveryError(`HTTP ${response.status}`, false)
      }
      throw new WebhookDeliveryError(`HTTP ${response.status}`, attempt < RETRIES)
    }
  } finally {
    clearTimeout(timer)
  }
}

export class WebhookDeliveryError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = "WebhookDeliveryError"
    this.retryable = retryable
  }
}

export async function deliverWebhook(
  config: ConfigWebhookV1.Info,
  payload: WebhookPayload,
  options: DeliveryOptions = {},
) {
  const body = webhookBody(payload)
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      await fetchOnce(config, body, attempt, options)
      return
    } catch (error) {
      const retryable = error instanceof WebhookDeliveryError ? error.retryable : true
      if (!retryable || attempt === RETRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

export function enqueueWebhook(config: ConfigWebhookV1.Info, payload: WebhookPayload, options?: DeliveryOptions) {
  void deliverWebhook(config, payload, options).catch(() => undefined)
}

type State = { busy: Set<string>; unsubscribe: Effect.Effect<void> }

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Webhook") {}

function sessionInfo(session: Session.Interface, sessionID: string) {
  return session.get(SessionID.make(sessionID)).pipe(
    Effect.map((info) => ({ id: info.id, title: info.title })),
    Effect.catch(() => Effect.succeed({ id: sessionID, title: "YukiOshi session" })),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Webhook.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const busy = new Set<string>()
        const emit = (event: WebhookEvent, sessionID: string, detail?: Record<string, unknown>) =>
          Effect.gen(function* () {
            const cfg = yield* config.get()
            const info = yield* sessionInfo(sessions, sessionID)
            const payload: WebhookPayload = {
              event,
              time: new Date().toISOString(),
              session: info,
              project: { directory: ctx.directory },
              ...(detail ? { detail } : {}),
            }
            for (const webhook of cfg.webhooks ?? []) {
              if (webhookWants(webhook, event)) enqueueWebhook(webhook, payload)
            }
          }).pipe(Effect.catchCause(() => Effect.void), Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          if (event.type === "session.status") {
            const data = event.data as { sessionID: string; status: { type: string } }
            if (data.status.type === "busy") {
              busy.add(data.sessionID)
              return Effect.void
            }
            if (data.status.type === "idle" && busy.delete(data.sessionID)) {
              return emit("turn.finished", data.sessionID)
            }
            return Effect.void
          }
          if (event.type === "session.error") {
            const data = event.data as { sessionID?: string; error?: { name?: string; message?: string } }
            return data.sessionID
              ? emit("turn.failed", data.sessionID, { error: data.error?.message ?? data.error?.name ?? "session error" })
              : Effect.void
          }
          if (event.type === "permission.asked") {
            const data = event.data as { sessionID: string; permission: string; patterns: string[] }
            return emit("permission.asked", data.sessionID, {
              permission: data.permission,
              patterns: data.patterns.slice(0, 8),
            })
          }
          if (event.type === "question.asked") {
            const data = event.data as { sessionID: string; questions: unknown[] }
            return emit("question.asked", data.sessionID, { count: data.questions.length })
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return { busy, unsubscribe }
      }),
    )

    const init = Effect.fn("Webhook.init")(function* () {
      yield* InstanceState.get(state)
    })
    return Service.of({ init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, EventV2Bridge.node, Session.node],
})

export * as Webhook from "./index"
