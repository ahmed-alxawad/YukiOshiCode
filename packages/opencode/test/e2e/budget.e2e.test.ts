import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, occurrences, runtimeEnv } from "./helpers"

function budgetEnv(home: string, url: string) {
  return {
    ...runtimeEnv(home),
    YUKIOSHI_DB: `${home}-data/budget.db`,
    YUKIOSHI_CONFIG_CONTENT: config(url),
  }
}

describe("spending limits", () => {
  cliIt.live(
    "a session token budget stops before the next model request",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { tokens: { session: 20 } } })
        yield* llm.text("first", { usage: { input: 10, output: 10 } })
        const env = budgetEnv(home, llm.url)
        const first = yield* opencode.run("first turn", { env })
        expect(first.exitCode).toBe(0)
        expect(yield* llm.calls).toBe(1)

        const second = yield* opencode.run("second turn", { env, extraArgs: ["--continue"] })
        expect(second.exitCode).toBe(6)
        expect(second.stderr).toContain("Session budget of 20 tokens reached")
        expect(second.stderr).toContain("Raise budget.tokens.session")
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "a daily token budget includes earlier sessions",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { tokens: { daily: 12 } } })
        yield* llm.text("first", { usage: { input: 7, output: 5 } })
        const env = budgetEnv(home, llm.url)
        const first = yield* opencode.run("first session", { env })
        expect(first.exitCode).toBe(0)
        expect(yield* llm.calls).toBe(1)

        const second = yield* opencode.run("new session", { env })
        expect(second.exitCode).toBe(6)
        expect(second.stderr).toContain("Daily budget of 12 tokens reached")
        expect(second.stderr).toContain("Raise budget.tokens.daily")
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "an 80 percent warning appears once before the next model call",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { tokens: { session: 100 } } })
        const file = path.join(home, "warning.txt")
        yield* Effect.promise(() => Bun.write(file, "budget warning fixture"))
        yield* llm.push(reply().tool("read", { filePath: file }).usage({ input: 60, output: 20 }))
        yield* llm.text("finished", { usage: { input: 1, output: 1 } })
        const result = yield* opencode.run("read the fixture", {
          env: budgetEnv(home, llm.url),
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("Session budget is at 80% (80 tokens of 100 tokens used)")
        expect(result.stderr).toContain("Raise budget.tokens.session")
        expect(occurrences(result.stderr, "Session budget is at 80%")).toBe(1)
        expect(yield* llm.calls).toBe(2)
      }),
    60_000,
  )

  cliIt.live(
    "run exits with code 6 when a budget blocks the turn",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { tokens: { session: 1 } } })
        yield* llm.text("charged", { usage: { input: 1, output: 0 } })
        const env = budgetEnv(home, llm.url)
        const first = yield* opencode.run("consume budget", { env })
        expect(first.exitCode).toBe(0)

        const blocked = yield* opencode.run("must fail", {
          env,
          format: "json",
          extraArgs: ["--continue"],
        })
        expect(blocked.exitCode).toBe(6)
        const events = opencode.parseJsonEvents(blocked.stdout)
        expect(events.some((event) => event.type === "error" && JSON.stringify(event).includes("budget.tokens.session"))).toBe(
          true,
        )
        expect(events.at(-1)).toMatchObject({ type: "result", exit_code: 6, reason: "budget" })
      }),
    60_000,
  )
})
