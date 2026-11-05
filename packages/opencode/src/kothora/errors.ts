// Error codes of the Kothora API (contracts/README.md in the Kothora backend) and the plain-language
// messages shown for them. The server's `message` is only an English fallback; the client translates by `code`.

export interface ApiErrorBody {
  code: string
  message?: string
  request_id?: string
}

// Whole escape sequences first (OSC incl. OSC-52 up to BEL/ST, then CSI and other ESC forms), then any
// remaining C0/C1 control, bidi override/isolate, line/paragraph separator and zero-width character.
const ESCAPE_SEQUENCES =
  /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[\x20-\x7e]?/g
const UNSAFE_CHARS = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Remove everything from server-supplied text that could act on the terminal or disguise what it says. */
export function sanitizeForTerminal(value: unknown) {
  return String(value).replace(ESCAPE_SEQUENCES, "").replace(UNSAFE_CHARS, "")
}

/** A failed call to the Kothora API. `userMessage` is safe to show as is; it never holds a stack trace. */
export class KothoraError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string
  readonly retryAfterSeconds?: number

  constructor(input: { code: string; status: number; message: string; requestId?: string; retryAfterSeconds?: number }) {
    super(sanitizeForTerminal(input.message))
    this.name = "KothoraError"
    this.code = sanitizeForTerminal(input.code)
    this.status = input.status
    this.requestId = input.requestId === undefined ? undefined : sanitizeForTerminal(input.requestId)
    this.retryAfterSeconds = input.retryAfterSeconds
  }

  get userMessage() {
    return this.message
  }
}

const CAPACITY = "Kothora has reached its capacity for this month and is not taking new requests. Please try again later."

const messages: Record<string, string> = {
  credits_exhausted: "Your credits for this month are used up. They renew at the start of next month.",
  paced_for_today: "You have used today's share of your monthly credits. Try again tomorrow.",
  spend_stopped_80: CAPACITY,
  spend_stopped_100: CAPACITY,
  not_authenticated: "You are not signed in. Run `kothora login`.",
  invalid_token: "This device was signed out. Run `kothora login` to sign in again.",
  token_expired: "Your sign-in expired. Run `kothora login` to sign in again.",
  invalid_grant: "Your sign-in is no longer valid. Run `kothora login` to sign in again.",
  unknown_model: "That model does not exist. Choose Fast, Balanced or Expert.",
  model_not_allowed: "Your plan does not include that model. Choose another one.",
  model_unavailable: "Kothora could not answer just now. Nothing was charged. Please try again.",
  gateway_unavailable: "Kothora is not available right now. Please try again later.",
  idempotency_key_reused: "This request clashed with an earlier one. Please send it again.",
  request_already_completed:
    "This request was already completed and charged, but the reply was cut off. Send it again if you still need it.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  waitlisted: "Your account is on the waitlist and cannot use Kothora Code yet.",
  account_suspended: "Your account is suspended.",
  email_not_verified: "Verify your email address in the Kothora web app first.",
  device_limit: "This account already has 3 devices. Sign one out in the Kothora web app (Settings, Devices), then try again.",
  expired_token: "The sign-in code expired. Run `kothora login` again.",
  access_denied: "Sign-in was denied in the browser.",
  stream_failed: "The reply was cut off. Please try again.",
}

export function messageFor(code: string, fallback?: string) {
  return messages[code] ?? fallback ?? `Kothora returned an error (${code}).`
}

/** Credits and spend stops are final for now: retrying the same call will not help. */
export const NO_RETRY = new Set([
  "credits_exhausted",
  "paced_for_today",
  "spend_stopped_80",
  "spend_stopped_100",
  "request_already_completed",
  "idempotency_key_reused",
  "model_not_allowed",
  "unknown_model",
])

/** Read `{"error": {"code", "message", "request_id"}}`; also accepts the RFC 8628 form `{"error": "code"}`. */
export function parseErrorBody(text: string): ApiErrorBody | undefined {
  try {
    const json = JSON.parse(text) as unknown
    if (!json || typeof json !== "object") return undefined
    const error = (json as { error?: unknown }).error
    if (typeof error === "string") return { code: error }
    if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string")
      return error as ApiErrorBody
  } catch {}
  return undefined
}

export async function errorFromResponse(res: Response): Promise<KothoraError> {
  const body = parseErrorBody(await res.text().catch(() => ""))
  const retryAfter = Number.parseFloat(res.headers.get("retry-after") ?? "")
  const code = body?.code ?? `http_${res.status}`
  return new KothoraError({
    code,
    status: res.status,
    message: messageFor(code, body?.message),
    requestId: body?.request_id ?? res.headers.get("x-request-id") ?? undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
  })
}

/** Shown whenever something tries to set up a provider of the user's own in the Kothora edition. */
export const BYOK_REFUSED =
  "Kothora Code uses Kothora as its only model provider. Bringing your own API key or provider is not supported in this edition. Run `kothora login` to sign in."
