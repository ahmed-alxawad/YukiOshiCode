import { describe, expect, test } from "bun:test"
import { Redact } from "../src/redact"

const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcdefghijklmnop"

describe("redact truncated private keys", () => {
  test("masks from BEGIN to the end of input when END is missing", () => {
    const out = Redact.mask(`before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY}`)
    expect(out).toBe("before\n[REDACTED:private-key]")
    expect(out).not.toContain("MIIEvQ")
  })

  test("masks the truncated tail even after a complete block", () => {
    const full = `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----`
    const out = Redact.mask(`${full}\nmid\n-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}`)
    expect(out).toBe("[REDACTED:private-key]\nmid\n[REDACTED:private-key]")
  })

  test("a complete block keeps the text after END", () => {
    const out = Redact.mask(`-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\nafter`)
    expect(out).toBe("[REDACTED:private-key]\nafter")
  })

  test("public keys and certificates are not masked", () => {
    const t = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n"
    expect(Redact.mask(t)).toBe(t)
    const p = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n"
    expect(Redact.mask(p)).toBe(p)
  })

  test("is linear on hostile input", () => {
    const inputs = [
      "-----BEGIN PRIVATE KEY-----".repeat(4_000),
      "-----BEGIN " + "A".repeat(100_000),
      "-----BEGIN PRIVATE KEY-----\n" + "-----END ".repeat(12_000),
      ("-----BEGIN " + "A".repeat(30)).repeat(3_000),
    ]
    const start = performance.now()
    for (const t of inputs) Redact.mask(t)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
