import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("memory", () => {
  cliIt.live("saves through memory_save and exposes the saved value to a later turn", ({ home, llm, opencode }) => Effect.gen(function* () {
    const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { memory: { enabled: true } }) }
    yield* llm.push(reply().tool("memory_save", { action: "remember", key: "e2e", text: "Use Bun" }))
    yield* llm.text("saved")
    const first = yield* opencode.run("remember this", { env, extraArgs: ["--dangerously-skip-permissions"] })
    expect(first.exitCode).toBe(0)
    yield* llm.reset
    yield* llm.push(reply().tool("memory_recall", { mode: "search", query: "e2e" }))
    yield* llm.text("recalled")
    const second = yield* opencode.run("recall it", { env })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain("recalled")
  }), 60_000)
})
