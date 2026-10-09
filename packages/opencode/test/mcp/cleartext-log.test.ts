import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Logger } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(LayerNode.compile(MCP.node))

describe("mcp cleartext warning", () => {
  it.instance("http to a non-local host is logged, https and loopback are not", () =>
    Effect.gen(function* () {
      const warnings: string[] = []
      const capture = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") warnings.push(JSON.stringify(options.message))
      })
      const mcp = yield* MCP.Service
      yield* Effect.gen(function* () {
        yield* mcp.add("plain", { type: "remote", url: "http://mcp-cleartext.invalid:9/mcp", oauth: false })
        yield* mcp.add("secure", { type: "remote", url: "https://mcp-secure.invalid:9/mcp", oauth: false })
        yield* mcp.add("local", { type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false })
      }).pipe(Effect.provide(Logger.layer([capture])))
      const cleartext = warnings.filter((line) => line.includes("unencrypted"))
      expect(cleartext).toHaveLength(1)
      expect(cleartext[0]).toContain("plain")
    }),
  )
})
