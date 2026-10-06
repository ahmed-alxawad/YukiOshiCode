import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("tool limits", () => {
  cliIt.live("continues after a tool call is limited", ({ home, llm, opencode }) => Effect.gen(function* () {
    yield* llm.push(reply().tool("bash", { command: "sleep 2", description: "slow" }))
    yield* llm.text("continued")
    const result = yield* opencode.run("run a slow command", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_limits: { timeout: 20 } }) }, extraArgs: ["--dangerously-skip-permissions"] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("continued")
  }), 60_000)
})
