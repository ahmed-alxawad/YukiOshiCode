import { describe, expect, test } from "bun:test"
import { KothoraClient } from "../../src/kothora/client"
import { authorize, formatMe, listModels, me, pollForTokens, platformName } from "../../src/kothora/device"
import { KothoraError } from "../../src/kothora/errors"
import { memoryTokenStore } from "../../src/kothora/tokens"
import { apiError, fakeServer, json, networkDown, tokenOut } from "./fake-server"

const BASE = "https://api.test.invalid"
const authorization = {
  device_code: "dc-secret",
  user_code: "ABCD-EFGH",
  verification_uri: `${BASE}/code/activate`,
  verification_uri_complete: `${BASE}/code/activate?user_code=ABCD-EFGH`,
  expires_in: 900,
  interval: 5,
}

function clock() {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
  }
}

describe("kothora device flow", () => {
  test("authorize sends the client name and platform and returns the codes", async () => {
    const server = fakeServer({ "/code/device/authorize": () => json(authorization) })
    const client = new KothoraClient({ baseUrl: BASE, store: memoryTokenStore(), fetch: server.fetch })
    const result = await authorize(client, { clientName: "Kothora Code", platform: "linux" })
    expect(result.user_code).toBe("ABCD-EFGH")
    expect(server.calls[0].body).toEqual({ client_name: "Kothora Code", platform: "linux" })
    expect(server.calls[0].headers.has("authorization")).toBe(false)
  })

  test("platform names follow the contract", () => {
    expect(platformName("win32")).toBe("windows")
    expect(platformName("darwin")).toBe("macos")
    expect(platformName("linux")).toBe("linux")
    expect(platformName("freebsd")).toBe("other")
  })

  test("pending, then slow_down (interval grows by 5 seconds), then success", async () => {
    const c = clock()
    const server = fakeServer({
      "/code/device/token": [
        () => apiError(400, "authorization_pending"),
        () => apiError(400, "slow_down"),
        () => apiError(400, "authorization_pending"),
        () => json(tokenOut(1)),
      ],
    })
    const notices: string[] = []
    const tokens = await pollForTokens(BASE, authorization, { ...c, fetch: server.fetch, onNotice: (m) => notices.push(m) })
    expect(c.sleeps).toEqual([5000, 5000, 10000, 10000])
    expect(server.calls[0].body).toEqual({ grant_type: "device_code", device_code: "dc-secret" })
    expect(notices[0]).toContain("10 seconds")
    expect(tokens).toEqual({
      access: "kca_access1",
      refresh: "kcr_refresh1",
      expires: 1_000_000 + 5000 + 5000 + 10000 + 10000 + 3600 * 1000,
      deviceId: "11111111-1111-4111-8111-111111111111",
    })
  })

  test("expired_token stops with a clear message", async () => {
    const server = fakeServer({ "/code/device/token": () => apiError(400, "expired_token") })
    const error = await pollForTokens(BASE, authorization, { ...clock(), fetch: server.fetch }).catch((e) => e)
    expect(error).toBeInstanceOf(KothoraError)
    expect(error.code).toBe("expired_token")
    expect(error.userMessage).toContain("kothora login")
  })

  test("the wait ends when the 15 minutes run out even if the server keeps saying pending", async () => {
    const server = fakeServer({ "/code/device/token": () => apiError(400, "authorization_pending") })
    const error = await pollForTokens(BASE, { ...authorization, expires_in: 12 }, { ...clock(), fetch: server.fetch }).catch((e) => e)
    expect(error.code).toBe("expired_token")
    expect(server.count("/code/device/token")).toBe(2)
  })

  test("access_denied stops and says so", async () => {
    const server = fakeServer({ "/code/device/token": () => apiError(400, "access_denied") })
    const error = await pollForTokens(BASE, authorization, { ...clock(), fetch: server.fetch }).catch((e) => e)
    expect(error.code).toBe("access_denied")
    expect(error.userMessage).toBe("Sign-in was denied in the browser.")
    expect(server.count("/code/device/token")).toBe(1)
  })

  test("device_limit keeps polling and tells the user once", async () => {
    const server = fakeServer({
      "/code/device/token": [() => apiError(409, "device_limit"), () => apiError(409, "device_limit"), () => json(tokenOut(1))],
    })
    const notices: string[] = []
    await pollForTokens(BASE, authorization, { ...clock(), fetch: server.fetch, onNotice: (m) => notices.push(m) })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("3 devices")
  })

  test("a dropped connection is retried with backoff and the sign-in still succeeds", async () => {
    const c = clock()
    const server = fakeServer({ "/code/device/token": [networkDown, networkDown, () => json(tokenOut(1))] })
    const notices: string[] = []
    const tokens = await pollForTokens(BASE, authorization, { ...c, fetch: server.fetch, onNotice: (m) => notices.push(m) })
    expect(tokens.access).toBe("kca_access1")
    expect(c.sleeps).toEqual([5000, 1000, 5000, 2000, 5000])
    expect(notices).toHaveLength(2)
  })

  test("invalid_grant ends the sign-in", async () => {
    const server = fakeServer({ "/code/device/token": () => apiError(400, "invalid_grant") })
    const error = await pollForTokens(BASE, authorization, { ...clock(), fetch: server.fetch }).catch((e) => e)
    expect(error.code).toBe("invalid_grant")
  })

  test("me and models use the bearer token and the contract shapes", async () => {
    const server = fakeServer({
      "/code/me": () =>
        json({
          account: { id: "a", email: "ada@example.com", name: "Ada" },
          plan: "tester",
          credits: { balance: "41.250", allowance: 100, renews_on: "2026-12-01" },
          device_id: "d",
        }),
      "/code/v1/models": () =>
        json({
          object: "list",
          data: [
            { id: "fast", name: "Fast", available: true },
            { id: "balanced", name: "Balanced", available: true },
            { id: "expert", name: "Expert", available: false },
          ],
        }),
    })
    const store = memoryTokenStore({ access: "kca_x", refresh: "kcr_x", expires: Date.now() + 3_600_000 })
    const client = new KothoraClient({ baseUrl: BASE, store, fetch: server.fetch })
    const info = await me(client)
    expect(server.calls[0].headers.get("authorization")).toBe("Bearer kca_x")
    expect(formatMe(info)).toBe(
      "Account: Ada <ada@example.com>\nPlan: tester\nCredits: 41.250 of 100 left, renews on 2026-12-01",
    )
    expect((await listModels(client)).map((m) => m.name)).toEqual(["Fast", "Balanced", "Expert"])
  })
})
