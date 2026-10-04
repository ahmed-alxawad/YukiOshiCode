import { describe, expect, test } from "bun:test"
import { KeyRotation } from "../../src/provider/key-rotation"

function server(okKey: string, status = 429) {
  const seen: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    seen.push(auth || new URL(url).searchParams.get("key") || "")
    const ok = auth.endsWith(okKey) || url.includes(`key=${okKey}`)
    return new Response(ok ? "ok" : "limited", { status: ok ? 200 : status })
  }
  return { seen, fetch }
}

describe("KeyRotation", () => {
  test("rests a rate-limited key and resends the request with the next one", async () => {
    const api = server("key-two")
    const rotation = KeyRotation.rotate(["key-one", "key-two"], api.fetch)
    const response = await rotation.fetch("https://api.test/v1", {
      method: "POST",
      headers: { authorization: "Bearer key-one" },
      body: "{}",
    })
    expect(response.status).toBe(200)
    expect(api.seen).toEqual(["Bearer key-one", "Bearer key-two"])
    expect(rotation.active()).toBe(1)

    // The next request starts on the key that worked.
    await rotation.fetch("https://api.test/v1", { headers: { authorization: "Bearer key-one" }, body: "{}" })
    expect(api.seen.at(-1)).toBe("Bearer key-two")
  })

  test("swaps a key passed in the query string", async () => {
    const api = server("key-two", 403)
    const rotation = KeyRotation.rotate(["key-one", "key-two"], api.fetch)
    const response = await rotation.fetch("https://api.test/v1?key=key-one", { body: "{}" })
    expect(response.status).toBe(200)
    expect(api.seen).toEqual(["key-one", "key-two"])
  })

  test("returns the last failure when every key is resting", async () => {
    const api = server("none")
    const rotation = KeyRotation.rotate(["a", "b", "c"], api.fetch)
    const response = await rotation.fetch("https://api.test", { headers: { authorization: "Bearer a" }, body: "{}" })
    expect(response.status).toBe(429)
    expect(api.seen).toEqual(["Bearer a", "Bearer b", "Bearer c"])
  })

  test("leaves other errors and streamed bodies alone", async () => {
    const api = server("b", 500)
    const rotation = KeyRotation.rotate(["a", "b"], api.fetch)
    expect((await rotation.fetch("https://api.test", { headers: { authorization: "Bearer a" } })).status).toBe(500)
    expect(api.seen).toEqual(["Bearer a"])

    const limited = server("b")
    const streaming = KeyRotation.rotate(["a", "b"], limited.fetch)
    const body = new ReadableStream({ start: (c) => c.close() })
    const response = await streaming.fetch("https://api.test", { headers: { authorization: "Bearer a" }, body })
    expect(response.status).toBe(429)
    expect(limited.seen).toEqual(["Bearer a"])
  })

  test("a resting key comes back after its retry-after time", async () => {
    let clock = 0
    const api = server("b")
    const rotation = KeyRotation.rotate(["a", "b"], api.fetch, () => clock)
    await rotation.fetch("https://api.test", { headers: { authorization: "Bearer a" }, body: "{}" })
    expect(rotation.active()).toBe(1)
    expect(KeyRotation.restMs(new Response("", { headers: { "retry-after": "5" } }))).toBe(5000)
    expect(KeyRotation.restMs(new Response(""))).toBe(60_000)
    clock = 61_000
    // Key "b" now fails too; "a" has rested long enough to be tried again.
    const failing = server("a")
    const again = KeyRotation.rotate(["a", "b"], failing.fetch, () => clock)
    await again.fetch("https://api.test", { headers: { authorization: "Bearer a" }, body: "{}" })
    expect(failing.seen).toEqual(["Bearer a"])
  })
})
