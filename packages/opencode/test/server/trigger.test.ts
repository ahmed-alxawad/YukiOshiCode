import { describe, expect, it } from "bun:test"
import { constantTimeCompare, resolveTriggers, isDirectoryBusy } from "../../src/server/trigger"

describe("resolveTriggers", () => {
  it("is off by default when triggers is not configured", () => {
    const resolved = resolveTriggers({})
    expect(resolved.enabled).toBe(false)
  })

  it("is off when triggers.enabled is false", () => {
    const resolved = resolveTriggers({
      triggers: {
        enabled: false,
        token_env: "TEST_TRIGGER_TOKEN",
      },
    })
    expect(resolved.enabled).toBe(false)
  })

  it("refuses to enable when token_env is unset", () => {
    const resolved = resolveTriggers({
      triggers: {
        enabled: true,
      },
    })
    expect(resolved.enabled).toBe(false)
    if (!resolved.enabled) {
      expect(resolved.reason).toContain("refused to enable because 'token_env' is not set")
    }
  })

  it("refuses to enable when environment variable is not defined", () => {
    delete process.env.NONEXISTENT_TRIGGER_TOKEN
    const resolved = resolveTriggers({
      triggers: {
        enabled: true,
        token_env: "NONEXISTENT_TRIGGER_TOKEN",
      },
    })
    expect(resolved.enabled).toBe(false)
    if (!resolved.enabled) {
      expect(resolved.reason).toContain("NONEXISTENT_TRIGGER_TOKEN' is unset")
    }
  })

  it("refuses to enable when token is shorter than 32 characters", () => {
    process.env.SHORT_TRIGGER_TOKEN = "short_token_only_20_ch"
    try {
      const resolved = resolveTriggers({
        triggers: {
          enabled: true,
          token_env: "SHORT_TRIGGER_TOKEN",
        },
      })
      expect(resolved.enabled).toBe(false)
      if (!resolved.enabled) {
        expect(resolved.reason).toContain("shorter than 32 characters")
      }
    } finally {
      delete process.env.SHORT_TRIGGER_TOKEN
    }
  })

  it("enables successfully when token has at least 32 characters", () => {
    const validToken = "a".repeat(32)
    process.env.VALID_TRIGGER_TOKEN = validToken
    try {
      const resolved = resolveTriggers({
        triggers: {
          enabled: true,
          token_env: "VALID_TRIGGER_TOKEN",
          directories: ["/tmp/allowed"],
        },
      })
      expect(resolved.enabled).toBe(true)
      if (resolved.enabled) {
        expect(resolved.token).toBe(validToken)
        expect(resolved.mode).toBe("review") // default is review
        expect(resolved.directories).toEqual(["/tmp/allowed"])
      }
    } finally {
      delete process.env.VALID_TRIGGER_TOKEN
    }
  })

  it("respects mode 'plan'", () => {
    process.env.VALID_TRIGGER_TOKEN = "b".repeat(40)
    try {
      const resolved = resolveTriggers({
        triggers: {
          enabled: true,
          token_env: "VALID_TRIGGER_TOKEN",
          mode: "plan",
        },
      })
      expect(resolved.enabled).toBe(true)
      if (resolved.enabled) {
        expect(resolved.mode).toBe("plan")
      }
    } finally {
      delete process.env.VALID_TRIGGER_TOKEN
    }
  })
})

describe("constantTimeCompare", () => {
  it("returns true for matching strings", () => {
    expect(constantTimeCompare("secret-token-12345", "secret-token-12345")).toBe(true)
  })

  it("returns false for different strings of same length", () => {
    expect(constantTimeCompare("secret-token-12345", "secret-token-12346")).toBe(false)
  })

  it("returns false for strings of different length", () => {
    expect(constantTimeCompare("secret", "secret-longer")).toBe(false)
    expect(constantTimeCompare("secret-longer", "secret")).toBe(false)
  })
})
