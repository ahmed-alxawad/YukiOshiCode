import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { globalConfig, runtimeEnv } from "./helpers"

describe("spending limits", () => {
  cliIt.live(
    "stops the next model request after a session token limit",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { session: 10, tokens: { session: 20 } } })
        yield* llm.text("first", { usage: { input: 10, output: 10 } })
        const env = { ...runtimeEnv(home), YUKIOSHI_DB: `${home}-data/budget.db` }
        const first = yield* opencode.run("first", {
          env,
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(first.exitCode).toBe(0)

        const second = yield* opencode.run("second", {
          env,
          extraArgs: ["--continue", "--dangerously-skip-permissions"],
        })
        expect(second.exitCode).toBe(1)
        expect(second.stderr).toContain("Session budget")
        expect(second.stderr).toContain("Raise budget.tokens.session")
      }),
    60_000,
  )
})
