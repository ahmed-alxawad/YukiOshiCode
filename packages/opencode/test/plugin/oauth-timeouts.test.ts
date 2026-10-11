import { afterEach, expect, test } from "bun:test"
import { CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"
import { requestDeviceCode } from "../../src/plugin/xai"

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
