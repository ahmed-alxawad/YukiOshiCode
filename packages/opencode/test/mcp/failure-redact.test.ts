import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(LayerNode.compile(MCP.node))
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"

describe("mcp.failure-redact", () => {
  it.instance("connection error text in status is secret-masked", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("leaky", { type: "local", command: [`/nonexistent/${SECRET}`] })
      const status = (result.status as Record<string, { status: string; error?: string }>)["leaky"]!
      expect(status.status).toBe("failed")
      expect(status.error).toBeDefined()
      expect(status.error).not.toContain(SECRET)
    }),
  )
})
