import { describe, expect, it, beforeEach } from "bun:test"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  constantTimeCompare,
  resolveTriggers,
  isDirectoryBusy,
  clearActiveDirectoriesForTest,
  handleTrigger,
} from "../../src/server/trigger"

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

describe("handleTrigger failure modes and safety", () => {
  const token = "a".repeat(32)
  const dir = "/tmp/trigger-test-dir"

  beforeEach(() => {
    clearActiveDirectoriesForTest()
    process.env.TRIGGER_TEST_TOKEN = token
  })

  const configSvc = {
    getGlobal: () =>
      Effect.succeed({
        triggers: {
          enabled: true,
          token_env: "TRIGGER_TEST_TOKEN",
          directories: [dir],
          mode: "review",
        },
      }),
  } as any

  it("failing mode.set means no prompt is sent, returns 500, and frees directory", async () => {
    let promptSent = false
    const mockSdk = {
      session: {
        create: async () => ({ data: { id: "ses_123" } }),
        prompt: async () => {
          promptSent = true
          return {}
        },
      },
      v2: {
        session: {
          permission: {
            mode: {
              set: async () => ({ error: { message: "Server error setting mode" } }),
              get: async () => ({ data: { data: "manual" } }),
            },
          },
        },
      },
    } as any

    const req = HttpServerRequest.fromWeb(
      new Request("http://localhost/trigger", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "do dangerous things", directory: dir }),
      }),
    )

    const res = await Effect.runPromise(handleTrigger(req, configSvc, { sdk: mockSdk }))
    expect(res.status).toBe(500)
    const body = (await HttpServerResponse.toWeb(res).json()) as Record<string, unknown>
    expect(body.error).toBe("could not start the run safely")
    expect(promptSent).toBe(false)
    expect(isDirectoryBusy(dir)).toBe(false)
  })

  it("ignored mode.set (mode.get returns different mode) returns 500 and frees directory", async () => {
    let promptSent = false
    const mockSdk = {
      session: {
        create: async () => ({ data: { id: "ses_123" } }),
        prompt: async () => {
          promptSent = true
          return {}
        },
      },
      v2: {
        session: {
          permission: {
            mode: {
              set: async () => ({ data: { data: "review" } }),
              get: async () => ({ data: { data: "manual" } }), // Mode was NOT actually applied!
            },
          },
        },
      },
    } as any

    const req = HttpServerRequest.fromWeb(
      new Request("http://localhost/trigger", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "do dangerous things", directory: dir }),
      }),
    )

    const res = await Effect.runPromise(handleTrigger(req, configSvc, { sdk: mockSdk }))
    expect(res.status).toBe(500)
    const body = (await HttpServerResponse.toWeb(res).json()) as Record<string, unknown>
    expect(body.error).toBe("could not start the run safely")
    expect(promptSent).toBe(false)
    expect(isDirectoryBusy(dir)).toBe(false)
  })

  it("internal error returns no stack or paths", async () => {
    const mockSdk = {
      session: {
        create: async () => {
          const err = new Error("Database failed at /secret/path/to/db.ts:42")
          err.stack = "Error: Database failed\n  at Object.<anonymous> (/secret/path/to/db.ts:42:15)"
          throw err
        },
      },
    } as any

    const req = HttpServerRequest.fromWeb(
      new Request("http://localhost/trigger", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "test prompt", directory: dir }),
      }),
    )

    const res = await Effect.runPromise(handleTrigger(req, configSvc, { sdk: mockSdk }))
    expect(res.status).toBe(500)
    const body = (await HttpServerResponse.toWeb(res).json()) as Record<string, unknown>
    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain("stack")
    expect(bodyStr).not.toContain("/secret/path")
    expect(bodyStr).not.toContain("detail")
    expect(isDirectoryBusy(dir)).toBe(false)
  })
})
