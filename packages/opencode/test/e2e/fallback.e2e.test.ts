import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { httpError, reply } from "../lib/llm-server"
import { config, runtimeEnv } from "./helpers"

describe("fallback and provider switching", () => {
  cliIt.live("switches to a working fallback model after a provider failure", ({ home, llm, opencode }) => Effect.gen(function* () {
    const provider = JSON.parse(config(llm.url)) as Record<string, any>
    provider.provider.backup = { ...provider.provider.test, id: "backup", name: "Backup" }
    provider.fallback = { enabled: true, models: ["backup/test-model"], cooldown: 0 }
    yield* llm.push(
      httpError(429, { error: { message: "rate limited" } }),
      httpError(429, { error: { message: "rate limited" } }),
      httpError(429, { error: { message: "rate limited" } }),
      reply().text("from fallback model").stop(),
    )
    const result = yield* opencode.run("hello", {
      env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: JSON.stringify(provider) },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("from fallback model")
    expect(yield* llm.calls).toBe(4)
  }), 60_000)
})
