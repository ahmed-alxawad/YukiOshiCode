import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const inline = { type: "local" as const, command: [process.execPath, stdioFixture] }

it.instance("an agent's inline MCP server is visible only to its session and stops when the session ends", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const names = yield* mcp.attach("ses_a", "reviewer", { docs: inline })
    expect(names).toEqual(["reviewer-docs"])

    expect(Object.keys(yield* mcp.tools("ses_a"))).toEqual(["reviewer-docs_current_directory"])
    // Another session, and callers without a session, never see it.
    expect(Object.keys(yield* mcp.tools("ses_b"))).toEqual([])
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    expect(Object.keys(yield* mcp.clients())).toContain("reviewer-docs")

    // A second session of the same agent shares the server; it stops with the last one.
    yield* mcp.attach("ses_b", "reviewer", { docs: inline })
    yield* mcp.detach("ses_a")
    expect(Object.keys(yield* mcp.tools("ses_b"))).toEqual(["reviewer-docs_current_directory"])
    yield* mcp.detach("ses_b")
    yield* pollWithTimeout(
      Effect.map(mcp.clients(), (clients) => (Object.keys(clients).length === 0 ? true : undefined)),
      "inline server was not stopped",
    )
    expect(Object.keys(yield* mcp.tools("ses_b"))).toEqual([])
    expect(Object.keys(yield* mcp.status())).not.toContain("reviewer-docs")
  }),
)
