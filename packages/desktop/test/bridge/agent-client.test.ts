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

  test("gets task status from the encoded task route", async () => {
    let request: { url?: string; method?: string } = {}
    const client = new AgentCoreClient("http://127.0.0.1:4096/", async (url, init) => {
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
      const client = new AgentCoreClient("http://127.0.0.1:4096/", async () => ({
        ok: true,
        status: 200,
        json: async () => response,
      }))
      await expect(client.getTask({ taskId: "task_7" })).rejects.toThrow("invalid task status")
    }
  })
})
