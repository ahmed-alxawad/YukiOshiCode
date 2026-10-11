import { afterEach, expect, test } from "bun:test"
import { CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"
import { pollDeviceCodeToken, requestDeviceCode } from "../../src/plugin/xai"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"

const realFetch = globalThis.fetch
const realNow = Date.now
afterEach(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
})

test("sign-in requests carry a timeout signal, so a server that never answers cannot hang the login", async () => {
  const signals: (AbortSignal | undefined)[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined)
    return new Response(
      JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "https://x.test", interval: 0, expires_in: 900 }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  await requestDeviceCode({ deviceAuthorizationUrl: "https://auth.test/device" })
  expect(signals).toHaveLength(1)
  expect(signals[0]).toBeDefined()
})

test("the Copilot device-code wait ends as failed once the code has expired", async () => {
  const signals: (AbortSignal | undefined)[] = []
  let polls = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined)
    if (String(url).endsWith("/login/device/code"))
      return new Response(
        JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "https://x.test", interval: 0 }),
        { status: 200 },
      )
    polls++
    // The user never approves; jump the clock past the wait limit after the first poll.
    Date.now = () => realNow() + 20 * 60_000
    return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 })
  }) as unknown as typeof fetch
  const hooks = await CopilotAuthPlugin({} as never)
  const method = hooks.auth!.methods[0] as { authorize(inputs?: Record<string, string>): Promise<any> }
  const started = await method.authorize({ deploymentType: "github.com" })
  const result = await started.callback()
  expect(result).toEqual({ type: "failed" })
  expect(polls).toBe(1)
  expect(signals.every((signal) => signal !== undefined)).toBe(true)
}, 30_000)

const timeout = () => new DOMException("The operation timed out.", "TimeoutError")

test("xAI: one poll that times out does not end the sign-in", async () => {
  let polls = 0
  globalThis.fetch = (async () => {
    polls++
    if (polls === 1) throw timeout()
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 })
  }) as unknown as typeof fetch
  const tokens = await pollDeviceCodeToken(
    { device_code: "d", user_code: "U", verification_uri: "https://x.test", interval: 1, expires_in: 600 } as never,
    { tokenUrl: "https://auth.test/token", sleep: async () => {} },
  )
  expect(tokens.access_token).toBe("a")
  expect(polls).toBe(2)
})

test("xAI: a poll error that is not a timeout still ends the sign-in", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused")
  }) as unknown as typeof fetch
  await expect(
    pollDeviceCodeToken(
      { device_code: "d", user_code: "U", verification_uri: "https://x.test", interval: 1, expires_in: 600 } as never,
      { tokenUrl: "https://auth.test/token", sleep: async () => {} },
    ),
  ).rejects.toThrow("connection refused")
})

test("Copilot: one poll that times out does not end the sign-in", async () => {
  let polls = 0
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/login/device/code"))
      return new Response(
        JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "https://x.test", interval: 0 }),
        { status: 200 },
      )
    polls++
    if (polls === 1) throw timeout()
    return new Response(JSON.stringify({ access_token: "gho_token" }), { status: 200 })
  }) as unknown as typeof fetch
  const hooks = await CopilotAuthPlugin({} as never)
  const method = hooks.auth!.methods[0] as { authorize(inputs?: Record<string, string>): Promise<any> }
  const started = await method.authorize({ deploymentType: "github.com" })
  const result = await started.callback()
  expect(result.type).toBe("success")
  expect(polls).toBe(2)
}, 30_000)

test("Codex: one poll that times out does not end the headless sign-in", async () => {
  let polls = 0
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url)
    if (target.endsWith("/deviceauth/usercode"))
      return new Response(JSON.stringify({ device_auth_id: "id", user_code: "U", interval: "1" }), { status: 200 })
    if (target.endsWith("/deviceauth/token")) {
      polls++
      if (polls === 1) throw timeout()
      return new Response(JSON.stringify({ authorization_code: "code", code_verifier: "v" }), { status: 200 })
    }
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 })
  }) as unknown as typeof fetch
  const hooks = await CodexAuthPlugin({} as never)
  const method = hooks.auth!.methods[1] as { authorize(): Promise<any> }
  const started = await method.authorize()
  const result = await started.callback()
  expect(result.type).toBe("success")
  expect(polls).toBe(2)
}, 30_000)
