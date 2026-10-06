import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, runtimeEnv } from "./helpers"

describe("untrusted repository", () => {
  cliIt.live("does not load project webhooks before trust", ({ home, llm, opencode }) => Effect.gen(function* () {
    const receiver = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    globalConfig(home, { webhooks: [{ url: `http://127.0.0.1:${receiver.port}` }] })
    yield* llm.text("untrusted")
    const result = yield* opencode.run("hello", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("untrusted")
    receiver.stop(true)
  }), 60_000)
})
