import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"

describe("session_search", () => {
  cliIt.live("runs the session_search tool in the real CLI tool loop", ({ llm, opencode }) => Effect.gen(function* () {
    yield* llm.push(reply().tool("session_search", { query: "earlier decision", scope: "project" }))
    yield* llm.text("search finished")
    const result = yield* opencode.run("search my sessions")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("search finished")
  }), 60_000)
})
