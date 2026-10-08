import { describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"
import { McpGuard } from "../../src/mcp/guard"

const it = testEffect(LayerNode.compile(MCP.node))

describe("mcp redirect handling", () => {
  test("a cross-origin redirect does not receive custom headers", async () => {
    const seen: Headers[] = []
    const evil = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new Headers(req.headers))
        return new Response("{}")
      },
    })
    const good = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://localhost:${evil.port}/mcp`, 307) })
    try {
      const call = McpGuard.sameOriginFetch()(`http://127.0.0.1:${good.port}/mcp`, {
        method: "POST",
        body: "{}",
        headers: { "x-api-key": "SECRET" },
      })
      await expect(call).rejects.toThrow("different origin")
      expect(seen).toHaveLength(0)
    } finally {
      await good.stop(true)
      await evil.stop(true)
    }
  })

  test("a same-origin redirect is followed and bounded", async () => {
    const good = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/loop") return Response.redirect(`${url.origin}/loop`, 307)
        if (url.pathname === "/a") return Response.redirect(`${url.origin}/b`, 307)
        return new Response(req.headers.get("x-api-key"))
      },
    })
    try {
      const guarded = McpGuard.sameOriginFetch()
      const ok = await guarded(`${good.url}a`, { headers: { "x-api-key": "k" } })
      expect(await ok.text()).toBe("k")
      await expect(guarded(`${good.url}loop`)).rejects.toThrow("too many")
    } finally {
      await good.stop(true)
    }
  })

  it.instance("an MCP server cannot bounce configured headers to another origin", () =>
    Effect.gen(function* () {
      const seen: Headers[] = []
      const evil = Bun.serve({
        port: 0,
        fetch(req) {
          seen.push(new Headers(req.headers))
          return new Response("{}")
        },
      })
      const good = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://localhost:${evil.port}/mcp`, 307) })
      yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([good.stop(true), evil.stop(true)])))
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("redirector", {
        type: "remote",
        url: good.url.toString(),
        oauth: false,
        headers: { "x-api-key": "SECRET" },
      })
      expect(result.status).toMatchObject({ redirector: { status: "failed" } })
      expect(seen).toHaveLength(0)
    }),
  )
})

describe("mcp remote url", () => {
  test("only http and https urls are accepted", () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "data:text/plain,hi", "not a url"])
      expect(McpGuard.remoteUrl(bad)).toBeUndefined()
    expect(McpGuard.remoteUrl("https://example.com/mcp")?.host).toBe("example.com")
    expect(McpGuard.remoteUrl("http://127.0.0.1:1/mcp")?.host).toBe("127.0.0.1:1")
  })

  test("cleartext http to a non-local host is flagged", () => {
    expect(McpGuard.isCleartextRemote(new URL("http://example.com/mcp"))).toBe(true)
    expect(McpGuard.isCleartextRemote(new URL("https://example.com/mcp"))).toBe(false)
    for (const local of ["http://localhost:1/", "http://127.0.0.1/", "http://[::1]:3/"])
      expect(McpGuard.isCleartextRemote(new URL(local))).toBe(false)
  })

  it.instance("a file: server url is refused", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("local-file", { type: "remote", url: "file:///etc/passwd", oauth: false })
      expect(result.status).toMatchObject({ "local-file": { status: "failed", error: 'Invalid MCP URL for "local-file"' } })
    }),
  )
})
