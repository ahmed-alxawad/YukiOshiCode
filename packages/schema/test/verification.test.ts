import { describe, expect, test } from "bun:test"
import { Verification } from "../src/verification"
import { Schema } from "effect"

describe("Verification schema contract", () => {
  test("validates all canonical statuses", () => {
    for (const status of Verification.STATUSES) {
      const decoded = Schema.decodeSync(Verification.Status)(status)
      expect(decoded).toBe(status)
    }

    expect(() => Schema.decodeUnknownSync(Verification.Status)("UNKNOWN")).toThrow()
  })

  test("encodes and decodes Verification.Check", () => {
    const check: Verification.Check = {
      kind: "test",
      label: "bun test",
      status: "passed",
      command: "bun test",
      exitCode: 0,
      durationMs: 150,
      evidence: "10 pass, 0 fail",
    }

    const encoded = Schema.encodeSync(Verification.Check)(check)
    const decoded = Schema.decodeSync(Verification.Check)(encoded)
    expect(decoded).toEqual(check)
  })

  test("encodes and decodes Verification.Summary", () => {
    const summary: Verification.Summary = {
      status: "VERIFIED",
      checks: [
        {
          kind: "test",
          label: "Unit tests",
          status: "passed",
          durationMs: 200,
          evidence: "All tests pass",
        },
      ],
      explanation: "Unit tests passed.",
    }

    const encoded = Schema.encodeSync(Verification.Summary)(summary)
    const decoded = Schema.decodeSync(Verification.Summary)(encoded)
    expect(decoded).toEqual(summary)
  })
})
