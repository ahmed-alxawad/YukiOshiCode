import { describe, expect, test } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"
import { McpGuard } from "../../src/mcp/guard"

const it = testEffect(LayerNode.compile(MCP.node))

describe("remote MCP private addresses", () => {
  it.instance("a server on a local address is not contacted unless the global config allows it", () =>
    Effect.gen(function* () {
      let requests = 0
      const local = Bun.serve({
        port: 0,
        fetch() {
          requests++
          return new Response("{}")
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => local.stop(true)))
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("admin", { type: "remote", url: `http://127.0.0.1:${local.port}/admin`, oauth: false })
      expect(result.status).toMatchObject({ admin: { status: "failed", error: expect.stringContaining("not contacted") } })
      expect(requests).toBe(0)
    }),
  )

  test("every request is checked, so a name resolving to cloud metadata is refused", async () => {
    const reached: string[] = []
    const base = (async (input: Parameters<typeof fetch>[0]) => {
      reached.push(String(input))
      return new Response("ok")
    }) as typeof fetch
    const resolver = async (hostname: string) =>
      hostname === "metadata.example"
        ? [{ address: "169.254.169.254", family: 4 as const }]
        : [{ address: "93.184.216.34", family: 4 as const }]
    const guarded = McpGuard.publicOnlyFetch(base, resolver)

    await expect(guarded("http://metadata.example/latest/meta-data/")).rejects.toThrow("not contacted")
    expect(await (await guarded("https://mcp.example/mcp")).text()).toBe("ok")
    expect(reached).toEqual(["https://mcp.example/mcp"])
  })
})
