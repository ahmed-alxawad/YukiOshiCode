import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("semantic search and code graph", () => {
  cliIt.live("runs both fallback tools through the real registry", ({ home, llm, opencode }) => Effect.gen(function* () {
    const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { indexing: { enabled: true }, code_graph: { enabled: true } }) }
    yield* llm.push(reply().tool("code_search", { query: "auth" }))
    yield* llm.text("search complete")
    expect((yield* opencode.run("search", { env })).exitCode).toBe(0)
    yield* llm.reset
    yield* llm.push(reply().tool("code_graph", { operation: "status" }))
    yield* llm.text("graph complete")
    const result = yield* opencode.run("graph", { env })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("graph complete")
  }), 60_000)
})
