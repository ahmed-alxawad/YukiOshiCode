import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("MCP tool search", () => {
  cliIt.live("boots with MCP tool search enabled and completes a real turn", ({ home, llm, opencode }) => Effect.gen(function* () {
    yield* llm.text("mcp ready")
    const result = yield* opencode.run("say hello", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_search: { enabled: true, threshold: 1 } }) } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("mcp ready")
  }), 60_000)
})
