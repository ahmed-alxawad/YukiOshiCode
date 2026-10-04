// Fallback models: when a step fails because of the provider (rate limit, overload, server error,
// billing or sign-in failure) and the normal retries did not help, the turn continues on the next model
// in `fallback.models`. Problems a different model would not fix (the user stopping the turn, a
// content filter, a conversation that is too long) never switch models.

const PROVIDER_STATUS = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504, 520, 522, 524, 529])
const PROVIDER_MESSAGE = /rate.?limit|quota|overloaded|capacity|insufficient|billing|unavailable|credit/i

type MessageError = { name: string; data?: Record<string, unknown> } | undefined

/** True when another provider or model could plausibly finish the step. */
export function eligible(error: MessageError) {
  if (!error) return false
  if (error.name === "ProviderAuthError") return true
  if (error.name !== "APIError") return false
  const data = error.data ?? {}
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  if (status !== undefined && PROVIDER_STATUS.has(status)) return true
  if (data.isRetryable === true) return true
  return typeof data.message === "string" && PROVIDER_MESSAGE.test(data.message)
}

/** The configured fallback models still to try, in order, as "provider/model". */
export function candidates(models: readonly string[] | undefined, tried: ReadonlySet<string>) {
  return (models ?? []).map((item) => item.trim()).filter((item) => item.includes("/") && !tried.has(item))
}

export * as SessionFallback from "./fallback"
