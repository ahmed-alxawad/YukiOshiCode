import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "../src/cors"

describe("server CORS", () => {
  test.each([
    "https://yukioshi.com",
    "https://www.yukioshi.com",
    "https://app.preview.yukioshi.com",
    "https://opencode.ai",
    "https://app.opencode.ai",
  ])("allows trusted web origin %s", (origin) => {
    expect(isAllowedCorsOrigin(origin)).toBe(true)
  })

  test.each([
    "http://yukioshi.com",
    "https://yukioshi.com.evil.example",
    "https://notyukioshi.com",
    "https://opencode.ai.evil.example",
  ])("rejects untrusted lookalike origin %s", (origin) => {
    expect(isAllowedCorsOrigin(origin)).toBe(false)
  })

  test("retains local, desktop, explicit, and same-host access", () => {
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:3000")).toBe(true)
    expect(isAllowedCorsOrigin("tauri://localhost")).toBe(true)
    expect(isAllowedCorsOrigin("https://custom.example", { cors: ["https://custom.example"] })).toBe(true)
    expect(isAllowedRequestOrigin("https://workspace.example", "workspace.example")).toBe(true)
  })
})
