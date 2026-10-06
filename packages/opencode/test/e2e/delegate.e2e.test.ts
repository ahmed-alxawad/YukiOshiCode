import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("delegate", () => {
  cliIt.live("runs the configured ACP mock agent through the real CLI", ({ home, llm, opencode }) => Effect.gen(function* () {
    const mock = path.resolve(import.meta.dir, "../delegate/mock-acp-agent.ts")
    const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { delegate: { enabled: true, agents: { mock: { command: [process.execPath, mock, "normal"] } } } }) }
    yield* llm.push({ type: "sse", head: [], tail: [] } as never)
    const result = yield* opencode.run("delegate this", { env, extraArgs: ["--dangerously-skip-permissions"] })
    expect(result.exitCode).toBe(0)
  }), 60_000)
})
