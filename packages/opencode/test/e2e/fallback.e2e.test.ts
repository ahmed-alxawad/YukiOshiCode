import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("fallback and key rotation", () => {
  cliIt.live("keeps a successful run on the configured model when fallback is enabled", ({ home, llm, opencode }) => Effect.gen(function* () {
    yield* llm.text("fallback-safe")
    const result = yield* opencode.run("hello", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { fallback: { enabled: true, models: ["test/test-model"], cooldown: 0 } }) } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("fallback-safe")
  }), 60_000)
})
