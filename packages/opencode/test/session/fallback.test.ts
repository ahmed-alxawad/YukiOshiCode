import { describe, expect, test } from "bun:test"
import { SessionFallback } from "../../src/session/fallback"

const api = (data: Record<string, unknown>) => ({ name: "APIError", data })

describe("SessionFallback", () => {
  test("switches models for provider-side failures", () => {
    expect(SessionFallback.eligible({ name: "ProviderAuthError", data: {} })).toBe(true)
    expect(SessionFallback.eligible(api({ statusCode: 429 }))).toBe(true)
    expect(SessionFallback.eligible(api({ statusCode: 503 }))).toBe(true)
    expect(SessionFallback.eligible(api({ isRetryable: true }))).toBe(true)
    expect(SessionFallback.eligible(api({ message: "You exceeded your current quota" }))).toBe(true)
  })

  test("keeps the model for problems another model would not fix", () => {
    expect(SessionFallback.eligible(undefined)).toBe(false)
    expect(SessionFallback.eligible({ name: "MessageAbortedError", data: {} })).toBe(false)
    expect(SessionFallback.eligible({ name: "ContextOverflowError", data: {} })).toBe(false)
    expect(SessionFallback.eligible(api({ statusCode: 400, message: "invalid tool schema" }))).toBe(false)
  })

  test("lists untried fallback models in order", () => {
    const models = [" openai/gpt-5 ", "anthropic/claude-sonnet-5", "not-a-model", "google/gemini-3.1-pro"]
    expect(SessionFallback.candidates(models, new Set(["anthropic/claude-sonnet-5"]))).toEqual([
      "openai/gpt-5",
      "google/gemini-3.1-pro",
    ])
    expect(SessionFallback.candidates(undefined, new Set())).toEqual([])
  })
})
