import { describe, expect, test } from "bun:test"
import { AgentCoreClient } from "../../src/main/agent-client"

describe("AgentCoreClient", () => {
  const token = "A".repeat(43)

  test("accepts only uncredentialed loopback HTTP endpoints", () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    expect(() => new AgentCoreClient("https://127.0.0.1:4096/", token, fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://example.com:4096/", token, fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://user:pass@localhost:4096/", token, fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://localhost:4096/base", token, fetch)).toThrow("loopback")
    expect(() => new AgentCoreClient("http://[::1]:4096/", token, fetch)).not.toThrow()
  })

  test("requires a base64url per-launch token", () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    for (const invalid of ["", "A".repeat(42), "A".repeat(129), `${"A".repeat(42)}+`, `${"A".repeat(42)}=`]) {
      expect(() => new AgentCoreClient("http://127.0.0.1:4096/", invalid, fetch)).toThrow("base64url")
    }
    expect(() => new AgentCoreClient("http://127.0.0.1:4096/", `${"a".repeat(42)}_`, fetch)).not.toThrow()
  })

  test("authenticates every request and disables redirects", async () => {
    let redirect: RequestRedirect | undefined
    let authorization: string | null = null
    const client = new AgentCoreClient("http://127.0.0.1:4096/", token, async (_url, init) => {
      redirect = init?.redirect
      authorization = new Headers(init?.headers).get("authorization")
      return { ok: true, status: 200, json: async () => [] }
    })

    await expect(client.listChanges()).resolves.toEqual([])
    expect(redirect).toBe("error")
    expect(authorization).toBe(`Basic ${Buffer.from(`kothora-desktop:${token}`).toString("base64")}`)
  })

  test("rejects malformed responses and reports request failures", async () => {
    const malformed = new AgentCoreClient("http://127.0.0.1:4096/", token, async () => ({
      ok: true,
      status: 200,
      json: async () => [{ path: "x", additions: -1, deletions: 0, status: "M" }],
    }))
    await expect(malformed.listChanges()).rejects.toThrow("invalid changes")

    const failed = new AgentCoreClient("http://127.0.0.1:4096/", token, async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ignored: true }),
    }))
    await expect(failed.listChanges()).rejects.toThrow("Agent core request failed (401)")
  })

  test("gets task status from the encoded task route", async () => {
    let request: { url?: string; method?: string } = {}
    const client = new AgentCoreClient("http://127.0.0.1:4096/", token, async (url, init) => {
      request = { url, method: init?.method }
      return { ok: true, status: 200, json: async () => ({ taskId: "task_7", status: "complete" }) }
    })
    await expect(client.getTask({ taskId: "task_7" })).resolves.toEqual({ taskId: "task_7", status: "complete" })
    expect(request).toEqual({ url: "http://127.0.0.1:4096/desktop/tasks/task_7", method: "GET" })
  })

  test("rejects invalid or mismatched task status responses", async () => {
    for (const response of [
      { taskId: "other", status: "running" },
      { taskId: "task_7", status: "unknown" },
      { taskId: 7, status: "complete" },
    ]) {
      const client = new AgentCoreClient("http://127.0.0.1:4096/", token, async () => ({
        ok: true,
        status: 200,
        json: async () => response,
      }))
      await expect(client.getTask({ taskId: "task_7" })).rejects.toThrow("invalid task status")
    }
  })
})
