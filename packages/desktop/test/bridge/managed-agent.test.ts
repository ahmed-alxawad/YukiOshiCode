import { describe, expect, test } from "bun:test"
import { ManagedAgent } from "../../src/main/managed-agent"

describe("ManagedAgent", () => {
  test("starts per workspace, authenticates requests, and disposes the previous process", async () => {
    const disposed: string[] = []
    const starts: string[] = []
    const headers: string[] = []
    const agent = new ManagedAgent(
      "/app/agent/yukioshi",
      async (_url, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "")
        return { ok: true, status: 200, json: async () => [] }
      },
      async ({ executable, workspace }) => {
        expect(executable).toBe("/app/agent/yukioshi")
        starts.push(workspace)
        return {
          baseUrl: "http://127.0.0.1:49152/",
          token: "A".repeat(43),
          dispose: () => disposed.push(workspace),
        }
      },
    )

    await expect(agent.listChanges()).rejects.toThrow("Select a workspace")
    await agent.selectWorkspace("/work/one")
    await expect(agent.listChanges()).resolves.toEqual([])
    await agent.selectWorkspace("/work/two")
    agent.dispose()

    expect(starts).toEqual(["/work/one", "/work/two"])
    expect(disposed).toEqual(["/work/one", "/work/two"])
    expect(headers).toEqual([`Basic ${Buffer.from(`kothora-desktop:${"A".repeat(43)}`).toString("base64")}`])
  })

  test("disposes a stale process when workspace selections overlap", async () => {
    let releaseFirst!: (value: { baseUrl: string; token: string; dispose(): void }) => void
    const disposed: string[] = []
    const first = new Promise<{ baseUrl: string; token: string; dispose(): void }>((resolve) => {
      releaseFirst = resolve
    })
    const agent = new ManagedAgent(
      "/agent",
      async () => ({ ok: true, status: 200, json: async () => [] }),
      async ({ workspace }) =>
        workspace === "/one"
          ? first
          : { baseUrl: "http://127.0.0.1:2/", token: "B".repeat(43), dispose: () => disposed.push("two") },
    )
    const selectingFirst = agent.selectWorkspace("/one")
    await agent.selectWorkspace("/two")
    releaseFirst({ baseUrl: "http://127.0.0.1:1/", token: "A".repeat(43), dispose: () => disposed.push("one") })
    await selectingFirst
    await expect(agent.listChanges()).resolves.toEqual([])
    agent.dispose()
    expect(disposed).toEqual(["one", "two"])
  })
})
