import { expect, test } from "bun:test"
import {
  OpencodeHostBlockedError,
  assertNotOpencodeRequest,
  guardFetch,
  isOpencodeHost,
  stripOpencodeProviders,
} from "../src/opencode-guard"

test("isOpencodeHost matches opencode.ai and subdomains only", () => {
  for (const url of [
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/zen/go/v1/chat/completions",
    "https://api.OPENCODE.ai/x",
    "https://opencode.ai./x",
    "opencode.ai/zen",
    "https://models.opencode.ai",
    "https://opncd.ai/s/1",
    new URL("https://x.opencode.ai"),
  ])
    expect(isOpencodeHost(url)).toBe(true)
  for (const url of [
    "https://api.openai.com/v1",
    "https://notopencode.ai/x",
    "https://opencode.ai.evil.com/x",
    "https://evil.com/?u=opencode.ai",
    "",
    undefined,
    42,
  ])
    expect(isOpencodeHost(url)).toBe(false)
})

test("stripOpencodeProviders removes by id, provider api host and model api host", () => {
  const catalog = {
    opencode: { id: "opencode", api: "https://opencode.ai/zen/v1" },
    "opencode-go": { id: "opencode-go", api: "https://opencode.ai/zen/go/v1" },
    mirror: { id: "mirror", api: "https://zen.opencode.ai/v1" },
    sneaky: {
      id: "sneaky",
      api: "https://api.example.com",
      models: { m: { provider: { api: "https://opencode.ai/x" } } },
    },
    renamed: { id: "opencode", api: "https://example.com" },
    openai: { id: "openai", api: "https://api.openai.com/v1" },
  }
  expect(Object.keys(stripOpencodeProviders(catalog))).toEqual(["openai"])
  const clean = { openai: catalog.openai }
  expect(stripOpencodeProviders(clean)).toBe(clean)
})

test("guard refuses requests to opencode hosts before the network is touched", async () => {
  let calls = 0
  const guarded = guardFetch(async (_input: unknown) => {
    calls++
    return new Response("ok")
  })
  for (const target of [
    "https://opencode.ai/zen/v1/chat/completions",
    new URL("https://opencode.ai/zen/go/v1/messages"),
    new Request("https://sub.opencode.ai/x", { method: "POST", body: "secret prompt" }),
  ]) {
    await expect(guarded(target)).rejects.toBeInstanceOf(OpencodeHostBlockedError)
  }
  expect(() => assertNotOpencodeRequest("https://opencode.ai/")).toThrow(/operated by opencode and is disabled/)
  expect(calls).toBe(0)
  expect(await (await guarded("https://api.openai.com/v1")).text()).toBe("ok")
  expect(calls).toBe(1)
})
