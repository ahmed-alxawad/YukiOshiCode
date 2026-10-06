import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, runtimeEnv } from "./helpers"

describe("hooks", () => {
  cliIt.live("adds UserPromptSubmit hook output to the real model request", ({ home, llm, opencode }) => Effect.gen(function* () {
    globalConfig(home, { hooks: { userPromptSubmit: [{ command: "printf e2e-hook" }] } })
    yield* llm.text("hooked")
    const result = yield* opencode.run("hello", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) } })
    expect(result.exitCode).toBe(0)
    expect(JSON.stringify(yield* llm.inputs)).toContain("e2e-hook")
  }), 60_000)
})
