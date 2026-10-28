import { describe, expect, test } from "bun:test"
import { AgentCoreClient } from "../../src/main/agent-client"

describe("AgentCoreClient", () => {
  test("accepts only uncredentialed loopback HTTP endpoints", () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    expect(() => new AgentCoreClient("https://127.0.0.1:4096/", fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://example.com:4096/", fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://user:pass@localhost:4096/", fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://localhost:4096/base", fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://[::1]:4096/", fetch)).not.toThrow()
  })

  test("rejects malformed agent responses and disables redirects", async () => {
    let redirect: RequestRedirect | undefined
    const client = new AgentCoreClient("http://127.0.0.1:4096/", async (_url, init) => {
      redirect = init?.redirect
      return { ok: true, status: 200, json: async () => [{ path: "x", additions: -1, deletions: 0, status: "M" }] }
    })

    await expect(client.listChanges()).rejects.toThrow("invalid changes")
    expect(redirect).toBe("error")
  })
})
