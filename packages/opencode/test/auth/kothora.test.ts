import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@yukioshi/plugin"
import { createKothoraAuthHooks } from "../../src/plugin/kothora"

const originalBaseUrl = process.env.KOTHORA_BASE_URL
const activeServers: Bun.Server<never>[] = []

type StubOptions = {
  authorize?: (request: Request) => Response
  token: (request: Request, poll: number) => Response
}

/** Local Kothora backend stub. Pointing KOTHORA_BASE_URL at it also proves the override is honored. */
function startStub(options: StubOptions) {
  const authorizeBodies: unknown[] = []
  const tokenBodies: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/code/device/authorize") {
        authorizeBodies.push(await request.json())
        return options.authorize ? options.authorize(request) : deviceResponse()
      }
      if (url.pathname === "/code/device/token") {
        tokenBodies.push(await request.json())
        return options.token(request, tokenBodies.length)
      }
      return new Response("Not found", { status: 404 })
    },
  })
  activeServers.push(server)
  process.env.KOTHORA_BASE_URL = `http://127.0.0.1:${server.port}`
  return { authorizeBodies, tokenBodies }
}

// 0.5 seconds so the waits are exact numbers: interval * 1000 = 500 and (interval + 5) * 1000 = 5500.
function deviceResponse() {
  return Response.json({
    device_code: "device-code-1",
    user_code: "ABCD-1234",
    verification_uri: "https://kothora.com/activate",
    interval: 0.5,
    expires_in: 300,
  })
}

function recordingSleep(waits: number[]) {
  return async (ms: number) => {
    waits.push(ms)
  }
}

function oauthMethod(hooks: Hooks) {
  const method = hooks.auth?.methods.find((method) => method.type === "oauth")
  if (!method || method.type !== "oauth") throw new Error("Kothora OAuth method is missing")
  return method
}

afterEach(() => {
  for (const server of activeServers.splice(0)) server.stop(true)
  if (originalBaseUrl === undefined) delete process.env.KOTHORA_BASE_URL
  else process.env.KOTHORA_BASE_URL = originalBaseUrl
})

describe("plugin.kothora", () => {
  test("starts a device sign-in and stores the access token on the first poll", async () => {
    const stub = startStub({ token: () => Response.json({ access_token: "kth-token" }) })
    const hooks = await createKothoraAuthHooks()
    expect(hooks.auth?.provider).toBe("kothora")
    const method = oauthMethod(hooks)
    expect(method.label).toBe("Sign in to Kothora (device code)")

    const authorization = await method.authorize()
    expect(stub.authorizeBodies[0]).toEqual({ client_name: "YukiOshi", platform: process.platform })
    expect(authorization.url).toBe("https://kothora.com/activate")
    expect(authorization.instructions).toContain("ABCD-1234")
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    const result = await authorization.callback()
    expect(result.type).toBe("success")
    // The stored shape: success carries the access token as the key.
    expect(result).toEqual({ type: "success", key: "kth-token" })
    expect(stub.tokenBodies).toEqual([{ device_code: "device-code-1" }])
  })

  test("keeps polling while the user has not approved yet", async () => {
    const stub = startStub({
      token: (_request, poll) =>
        poll === 1
          ? Response.json({ error: "authorization_pending" }, { status: 400 })
          : Response.json({ access_token: "kth-token" }),
    })
    const waits: number[] = []
    const hooks = await createKothoraAuthHooks({ sleep: recordingSleep(waits) })
    const authorization = await oauthMethod(hooks).authorize()
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    expect(await authorization.callback()).toEqual({ type: "success", key: "kth-token" })
    expect(stub.tokenBodies).toHaveLength(2)
    expect(waits).toEqual([500])
  })

  test("adds five seconds to the interval after slow_down", async () => {
    const stub = startStub({
      token: (_request, poll) => {
        if (poll === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
        if (poll === 2) return Response.json({ error: "slow_down" }, { status: 429 })
        return Response.json({ access_token: "kth-token" })
      },
    })
    const waits: number[] = []
    const hooks = await createKothoraAuthHooks({ sleep: recordingSleep(waits) })
    const authorization = await oauthMethod(hooks).authorize()
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    expect(await authorization.callback()).toEqual({ type: "success", key: "kth-token" })
    expect(stub.tokenBodies).toHaveLength(3)
    // Waits one interval after the pending poll, then interval + 5 seconds (RFC 8628) after slow_down.
    expect(waits).toEqual([500, 5500])
  })

  test("fails when the request has expired", async () => {
    const stub = startStub({ token: () => Response.json({ error: "expired_token" }, { status: 400 }) })
    const hooks = await createKothoraAuthHooks()
    const authorization = await oauthMethod(hooks).authorize()
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    expect(await authorization.callback()).toEqual({ type: "failed" })
    expect(stub.tokenBodies).toHaveLength(1)
  })

  test("fails when the user rejects the request", async () => {
    const stub = startStub({ token: () => Response.json({ error: "rejected" }, { status: 400 }) })
    const hooks = await createKothoraAuthHooks()
    const authorization = await oauthMethod(hooks).authorize()
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    expect(await authorization.callback()).toEqual({ type: "failed" })
    expect(stub.tokenBodies).toHaveLength(1)
  })

  test("fails when the device limit is reached", async () => {
    const stub = startStub({ token: () => Response.json({ error: "device_limit_reached" }, { status: 403 }) })
    const hooks = await createKothoraAuthHooks()
    const authorization = await oauthMethod(hooks).authorize()
    if (authorization.method !== "auto") throw new Error("expected the polling device-code flow")

    expect(await authorization.callback()).toEqual({ type: "failed" })
    expect(stub.tokenBodies).toHaveLength(1)
  })
})
