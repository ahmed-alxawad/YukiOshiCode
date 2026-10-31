import { describe, expect, test } from "bun:test"
import { KothoraClient } from "../../src/kothora/client"
import { KothoraError, messageFor } from "../../src/kothora/errors"
import { providerFetch } from "../../src/kothora/provider"
import { memoryTokenStore, type TokenStore, type Tokens } from "../../src/kothora/tokens"
import { apiError, fakeServer, json, networkDown, tokenOut } from "./fake-server"

const BASE = "https://api.test.invalid"
const NOW = 5_000_000
const fresh: Tokens = { access: "kca_old", refresh: "kcr_old", expires: NOW + 3_600_000 }
const expired: Tokens = { access: "kca_old", refresh: "kcr_old", expires: NOW + 10_000 }

function setup(routes: Parameters<typeof fakeServer>[0], tokens: Tokens | null = fresh) {
  const server = fakeServer(routes)
  const store = memoryTokenStore(tokens ?? undefined)
  const sleeps: number[] = []
  let n = 0
  const client = new KothoraClient({
    baseUrl: BASE,
    store,
    fetch: server.fetch,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  })
  return { server, store, sleeps, client }
}

const completion = (body = "{}") => ({ method: "POST", body, headers: { "content-type": "application/json" } })

describe("kothora client: tokens", () => {
  test("a token that is still good is used as is", async () => {
    const { server, client } = setup({ "/code/me": () => json({ ok: true }) })
    await client.request("/code/me")
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0].headers.get("authorization")).toBe("Bearer kca_old")
  })

  test("a token about to expire is refreshed first and the new pair is saved", async () => {
    const { server, store, client } = setup(
      { "/code/device/token": () => json(tokenOut(2)), "/code/me": () => json({ ok: true }) },
      expired,
    )
    await client.request("/code/me")
    expect(server.calls[0].body).toEqual({ grant_type: "refresh_token", refresh_token: "kcr_old" })
    expect(server.calls[1].headers.get("authorization")).toBe("Bearer kca_access2")
    expect(store.current()).toMatchObject({ access: "kca_access2", refresh: "kcr_refresh2", expires: NOW + 3_600_000 })
  })

  test("a 401 token_expired refreshes once and retries the call", async () => {
    const { server, store, client } = setup({
      "/code/device/token": () => json(tokenOut(2)),
      "/code/me": [() => apiError(401, "token_expired"), () => json({ ok: true })],
    })
    const res = await client.request("/code/me")
    expect(res.status).toBe(200)
    expect(server.calls.map((c) => c.path)).toEqual(["/code/me", "/code/device/token", "/code/me"])
    expect(server.calls[2].headers.get("authorization")).toBe("Bearer kca_access2")
    expect(store.current()?.refresh).toBe("kcr_refresh2")
  })

  test("a second 401 after the refresh is shown, not looped on", async () => {
    const { server, client } = setup({
      "/code/device/token": () => json(tokenOut(2)),
      "/code/me": () => apiError(401, "invalid_token"),
    })
    const error = await client.request("/code/me").catch((e) => e)
    expect(error.code).toBe("invalid_token")
    expect(error.userMessage).toContain("kothora login")
    expect(server.count("/code/device/token")).toBe(1)
  })

  test("many calls that need a refresh at once spend the refresh token only once", async () => {
    const { server, client } = setup(
      {
        "/code/device/token": async () => {
          await Bun.sleep(10)
          return json(tokenOut(2))
        },
        "/code/me": () => json({ ok: true }),
      },
      expired,
    )
    await Promise.all([client.request("/code/me"), client.request("/code/me"), client.request("/code/me")])
    expect(server.count("/code/device/token")).toBe(1)
  })

  test("a network failure during refresh never loses the stored tokens", async () => {
    const { store, client } = setup({ "/code/device/token": networkDown }, expired)
    const error = await client.request("/code/me").catch((e) => e)
    expect(error.code).toBe("network_error")
    expect(error.userMessage).toContain("nothing was lost")
    expect(store.current()).toEqual(expired)
  })

  test("a refresh the server refuses keeps the stored tokens and says to sign in again", async () => {
    const { store, client } = setup({ "/code/device/token": () => apiError(400, "invalid_grant") }, expired)
    const error = await client.request("/code/me").catch((e) => e)
    expect(error.code).toBe("invalid_grant")
    expect(store.current()).toEqual(expired)
  })

  test("a refresh that cannot be saved is kept in memory for the session", async () => {
    const server = fakeServer({ "/code/device/token": () => json(tokenOut(2)), "/code/me": () => json({ ok: true }) })
    const store: TokenStore = {
      load: async () => expired,
      save: async () => {
        throw new Error("keychain locked")
      },
      clear: async () => {},
    }
    const client = new KothoraClient({ baseUrl: BASE, store, fetch: server.fetch, now: () => NOW, sleep: async () => {} })
    await client.request("/code/me")
    await client.request("/code/me")
    expect(server.count("/code/device/token")).toBe(1)
    expect(server.calls[2].headers.get("authorization")).toBe("Bearer kca_access2")
  })

  test("not signed in says to run kothora login without calling the server", async () => {
    const { server, client } = setup({}, null)
    const error = await client.request("/code/me").catch((e) => e)
    expect(error.code).toBe("not_authenticated")
    expect(server.calls).toHaveLength(0)
  })
})

describe("kothora client: retries and Idempotency-Key", () => {
  test("a retry after a dropped connection or a 5xx reuses the same Idempotency-Key", async () => {
    const { server, sleeps, client } = setup({
      "/code/v1/chat/completions": [networkDown, () => apiError(502, "model_unavailable"), () => json({ id: "chatcmpl" })],
    })
    const res = await client.request("/code/v1/chat/completions", completion(), { idempotent: true })
    expect(res.status).toBe(200)
    const keys = server.calls.map((c) => c.headers.get("idempotency-key"))
    expect(keys).toEqual(Array(3).fill("00000000-0000-4000-8000-000000000001"))
    expect(sleeps).toEqual([500, 1000])
    expect(server.calls.every((c) => c.headers.get("authorization") === "Bearer kca_old")).toBe(true)
  })

  test("each logical request gets its own key, and the key is a UUID", async () => {
    const { server, client } = setup({ "/code/v1/chat/completions": () => json({}) })
    await client.request("/code/v1/chat/completions", completion(), { idempotent: true })
    await client.request("/code/v1/chat/completions", completion(), { idempotent: true })
    const [a, b] = server.calls.map((c) => c.headers.get("idempotency-key"))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("the key stays the same when a 401 forces a refresh and a second try", async () => {
    const { server, client } = setup({
      "/code/device/token": () => json(tokenOut(2)),
      "/code/v1/chat/completions": [() => apiError(401, "token_expired"), () => json({})],
    })
    await client.request("/code/v1/chat/completions", completion(), { idempotent: true })
    const keys = server.calls.filter((c) => c.path.endsWith("completions")).map((c) => c.headers.get("idempotency-key"))
    expect(keys[0]).toBe(keys[1])
  })

  test("gives up after the attempts with a message that keeps the tokens", async () => {
    const { server, store, client } = setup({ "/code/v1/chat/completions": networkDown })
    const error = await client.request("/code/v1/chat/completions", completion(), { idempotent: true }).catch((e) => e)
    expect(error.code).toBe("network_error")
    expect(server.calls).toHaveLength(5)
    expect(store.current()).toEqual(fresh)
  })
})

describe("kothora client: credit and spend errors", () => {
  test.each([
    [402, "credits_exhausted", "Your credits for this month are used up. They renew at the start of next month."],
    [429, "paced_for_today", "You have used today's share of your monthly credits. Try again tomorrow."],
    [503, "spend_stopped_80", "Kothora has reached its capacity for this month and is not taking new requests. Please try again later."],
    [503, "spend_stopped_100", "Kothora has reached its capacity for this month and is not taking new requests. Please try again later."],
  ])("%d %s becomes a plain message and is not retried", async (status, code, message) => {
    const { server, client } = setup({ "/code/v1/chat/completions": () => apiError(status, code, { "retry-after": "30" }) })
    const error = await client.request("/code/v1/chat/completions", completion(), { idempotent: true }).catch((e) => e)
    expect(error).toBeInstanceOf(KothoraError)
    expect(error.userMessage).toBe(message)
    expect(error.status).toBe(status)
    expect(error.requestId).toBe("req-test-0001")
    expect(server.calls).toHaveLength(1)
    expect(error.userMessage).not.toContain("fallback message")
    expect(error.stack).toBeDefined() // kept for debugging, never printed by the CLI
  })

  test("an unknown code falls back to the server's English message", () => {
    expect(messageFor("brand_new_code", "Server words")).toBe("Server words")
    expect(messageFor("brand_new_code")).toContain("brand_new_code")
  })

  test("request_already_completed and idempotency_key_reused are explained", async () => {
    for (const code of ["request_already_completed", "idempotency_key_reused"]) {
      const { client } = setup({ "/code/v1/chat/completions": () => apiError(409, code) })
      const error = await client.request("/code/v1/chat/completions", completion(), { idempotent: true }).catch((e) => e)
      expect(error.code).toBe(code)
      expect(error.userMessage).not.toBe(`fallback message for ${code}`)
    }
  })
})

describe("kothora provider fetch", () => {
  test("sends the bearer token and an Idempotency-Key to the API", async () => {
    const { server, client } = setup({ "/code/v1/chat/completions": () => json({}) })
    await providerFetch(client, BASE)(`${BASE}/code/v1/chat/completions`, completion())
    expect(server.calls[0].headers.get("authorization")).toBe("Bearer kca_old")
    expect(server.calls[0].headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("never sends the token to another host", async () => {
    const { server, client } = setup({})
    const error = await providerFetch(client, BASE)("https://example.com/code/v1/chat/completions", completion()).catch((e) => e)
    expect(error.code).toBe("wrong_host")
    expect(server.calls).toHaveLength(0)
  })
})
