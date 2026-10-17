import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { explainSessionError } from "../../src/cli/error"
import { SessionRetry } from "../../src/session/retry"

describe("provider error messages and session explanation", () => {
  test("HTTP 400 API_KEY_INVALID: returns credentials advice naming provider and yukioshi providers login", () => {
    const rawMessage = "API key not valid. Please pass a valid API key."
    const error = new SessionV1.APIError({
      message: rawMessage,
      statusCode: 400,
      isRetryable: false,
      responseBody: JSON.stringify({
        error: {
          code: 400,
          message: rawMessage,
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      }),
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=AIzaSyD_SECRET_KEY_12345",
      },
    }).toObject()

    const text = explainSessionError(error as never, rawMessage)

    expect(text).toContain("generativelanguage.googleapis.com")
    expect(text).toContain("yukioshi providers login")
    expect(text).toMatch(/credentials|API key/i)
    expect(text).not.toContain("AIzaSyD_SECRET_KEY_12345")
    expect(text).not.toContain("?key=")
  })

  test("HTTP 403 PERMISSION_DENIED: gives project enablement advice", () => {
    const rawMessage = "Generative Language API has not been used in project 123456 before or it is disabled."
    const error = new SessionV1.APIError({
      message: rawMessage,
      statusCode: 403,
      isRetryable: false,
      responseBody: JSON.stringify({
        error: {
          code: 403,
          message: rawMessage,
          status: "PERMISSION_DENIED",
        },
      }),
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      },
    }).toObject()

    const text = explainSessionError(error as never, rawMessage)

    expect(text).toContain("generativelanguage.googleapis.com")
    expect(text).toMatch(/Generative Language API has not been enabled in your project or permission was denied/i)
    expect(text).toMatch(/Google Cloud Console/i)
  })

  test("HTTP 404 model not found: gives model catalog advice", () => {
    const rawMessage = "models/notfound is not found for API version v1beta, or is not supported for generateContent."
    const error = new SessionV1.APIError({
      message: rawMessage,
      statusCode: 404,
      isRetryable: false,
      responseBody: JSON.stringify({
        error: {
          code: 404,
          message: rawMessage,
          status: "NOT_FOUND",
        },
      }),
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/notfound:streamGenerateContent",
      },
    }).toObject()

    const text = explainSessionError(error as never, rawMessage)

    expect(text).toContain("generativelanguage.googleapis.com")
    expect(text).toMatch(/reported that the model was not found/i)
    expect(text).toContain("yukioshi models")
  })

  test("HTTP 429 with Retry-After > 10s: retryable() returns undefined and explainSessionError explains retry window exceeded limit", () => {
    const rawMessage = "You exceeded your current quota, please check your plan and billing details."
    const error = new SessionV1.APIError({
      message: rawMessage,
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { "retry-after": "3600" },
      responseBody: JSON.stringify({
        error: {
          code: 429,
          message: rawMessage,
          status: "RESOURCE_EXHAUSTED",
        },
      }),
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      },
    }).toObject()

    const retryDecision = SessionRetry.retryable(error as never, "google")
    expect(retryDecision).toBeUndefined()

    const text = explainSessionError(error as never, rawMessage)
    expect(text).toMatch(/Retry-After: 3600s exceeds the 10s retry limit/i)
    expect(text).toContain("--model")
  })

  test("HTTP 429 with short Retry-After <= 10s is retryable", () => {
    const error = new SessionV1.APIError({
      message: "Rate limit reached. Please retry in 2 seconds.",
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { "retry-after": "2" },
      responseBody: JSON.stringify({
        error: {
          code: 429,
          message: "Rate limit reached.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
    }).toObject()

    const retryDecision = SessionRetry.retryable(error as never, "google")
    expect(retryDecision).toBeDefined()
  })

  test("Safety block ContentFilterError: explainSessionError gives safety guidance", () => {
    const error = new SessionV1.ContentFilterError({
      message: "The response was blocked by the provider's content filter",
    }).toObject()

    const text = explainSessionError(error as never, error.data.message)

    expect(text).toMatch(/safety filter \(safety block\)/i)
    expect(text).toMatch(/Modify your prompt/i)
    expect(text).toContain("--model")
  })

  test("Empty response error: explainSessionError explains empty response", () => {
    const rawMessage = "The provider returned an empty response with no content"
    const error = new SessionV1.APIError({
      message: rawMessage,
      isRetryable: false,
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      },
    }).toObject()

    const text = explainSessionError(error as never, rawMessage)

    expect(text).toMatch(/returned an empty response with no content/i)
    expect(text).toContain("generativelanguage.googleapis.com")
    expect(text).toMatch(/Check provider status, retry your prompt/i)
  })

  test("scrubs secret keys, query params, and paths from URLs in all explanations", () => {
    const error = new SessionV1.APIError({
      message: "API key not valid",
      statusCode: 400,
      isRetryable: false,
      metadata: {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash?key=AIzaSy_SENSITIVE_KEY_XYZ&token=secret",
      },
    }).toObject()

    const text = explainSessionError(error as never, "API key not valid")

    expect(text).toContain("generativelanguage.googleapis.com")
    expect(text).not.toContain("AIzaSy_SENSITIVE_KEY_XYZ")
    expect(text).not.toContain("?key=")
    expect(text).not.toContain("token=secret")
    expect(text).not.toContain("/v1beta/models")
  })
})
