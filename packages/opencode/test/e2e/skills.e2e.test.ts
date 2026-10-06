import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

describe("learned skills", () => {
  cliIt.live("saves a skill through the real skill_save tool", ({ home, llm, opencode }) => Effect.gen(function* () {
    const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { skills: { learn: { enabled: true } } }) }
    yield* llm.push(reply().tool("skill_save", { action: "save", name: "e2e-skill", description: "Use in e2e", content: "Run the e2e command." }))
    yield* llm.text("skill saved")
    const result = yield* opencode.run("learn this", { env, extraArgs: ["--dangerously-skip-permissions"] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("skill saved")
  }), 60_000)
})
