import { describe, expect, test } from "bun:test"
import { explainSessionError } from "../../src/cli/error"

const url = "http://api.example.test:8080/v1/chat?key=SECRETKEY"

describe("timeout and retry messages", () => {
  test("a header timeout names the duration and provider.<id>.options.headerTimeout", () => {
    const text = explainSessionError(
      { name: "APIError", data: { metadata: { code: "ProviderHeaderTimeoutError", timeoutMs: "15000", url } } },
      "Provider response headers timed out after 15000ms",
    )
    expect(text).toContain("15s")
    expect(text).toContain("headerTimeout")
    expect(text).toContain("fallback.models")
    expect(text).toContain("api.example.test:8080")
    expect(text).not.toContain("SECRETKEY")
  })

  test("a stalled stream names the duration and provider.<id>.options.chunkTimeout", () => {
    const text = explainSessionError(
      { name: "APIError", data: { metadata: { code: "ProviderResponseStreamError", timeoutMs: "30000" } } },
      "Provider stream stalled: no data for 30000ms",
    )
    expect(text).toContain("30s")
    expect(text).toContain("chunkTimeout")
  })

  test("a server error that outlasts the retries says so and names fallback.models", () => {
    const text = explainSessionError({ name: "APIError", data: { statusCode: 503, metadata: { url } } }, "busy")
    expect(text).toContain("HTTP 503")
    expect(text).toContain("2 retries")
    expect(text).toContain("fallback.models")
  })

  test("a websocket stream error without a timeout gets no timeout advice", () => {
    const text = explainSessionError(
      { name: "APIError", data: { metadata: { code: "ProviderResponseStreamError" } } },
      "WebSocket closed",
    )
    expect(text).toBe("WebSocket closed")
  })
})
