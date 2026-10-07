import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { config, requestToolNames, runtimeEnv } from "./helpers"

// Each reply costs $1.50: 10 input and 5 output tokens at $100,000 per million tokens.
function pricedConfig(url: string, extra: Record<string, unknown> = {}) {
  const base = testProviderConfig(url)
  base.provider.test.models["test-model"].cost = { input: 100_000, output: 100_000 }
  return JSON.stringify({ ...base, ...extra })
}

const touch = (file: string) =>
  reply()
    .tool("bash", { command: `touch ${file}`, description: `create ${file}` })
    .usage({ input: 10, output: 5 })

describe("headless run", () => {
  cliIt.live(
    "--output-schema prints only the answer, as JSON, on stdout",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("StructuredOutput", { answer: "42", files: 3 }))
        const schema = {
          type: "object",
          properties: { answer: { type: "string" }, files: { type: "number" } },
          required: ["answer", "files"],
        }
        const result = yield* opencode.run("how many files are there", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--output-schema", JSON.stringify(schema)],
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe('{"answer":"42","files":3}')
        expect(requestToolNames((yield* llm.inputs)[0]!)).toContain("StructuredOutput")
      }),
    60_000,
  )

  cliIt.live(
    "--max-turns stops before the next turn and exits with 5",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(touch("t1"), touch("t2"), touch("t3"), touch("t4"))
        yield* llm.text("made all four")
        const result = yield* opencode.run("make four files", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--max-turns", "2", "--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(5)
        expect(result.stderr).toContain("Stopped after 2 turns (--max-turns 2).")
        expect(fs.existsSync(path.join(home, "t2"))).toBe(true)
        expect(fs.existsSync(path.join(home, "t3"))).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "--max-cost and the budget setting stop the run with exit code 6",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(touch("c1"), touch("c2"), touch("c3"))
        yield* llm.text("made them")
        const capped = yield* opencode.run("make three files", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: pricedConfig(llm.url) },
          extraArgs: ["--max-cost", "2.5", "--dangerously-skip-permissions"],
        })
        expect(capped.exitCode).toBe(6)
        expect(capped.stderr).toContain("Stopped after spending $3.00 (--max-cost $2.50).")
        expect(fs.existsSync(path.join(home, "c2"))).toBe(true)
        expect(fs.existsSync(path.join(home, "c3"))).toBe(false)

        yield* llm.reset
        yield* llm.push(touch("b1"), touch("b2"), touch("b3"))
        yield* llm.text("made them")
        const budget = yield* opencode.run("make three more files", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: pricedConfig(llm.url, { budget: { session: 2.5 } }) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(budget.exitCode).toBe(6)
        expect(budget.stderr).toContain("Session budget of $2.50 reached")
        expect(fs.existsSync(path.join(home, "b3"))).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "a goal that needs you exits with 3, one out of rounds with 4, and --format json ends with a result event",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = (extra: Record<string, unknown> = {}) => ({
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url, extra),
        })

        yield* llm.push(
          reply().text("Which database should the data go to?").stop(),
          reply().text("BLOCKED: it needs your decision on the database").stop(),
        )
        const blocked = yield* opencode.run("migrate the data", { command: "goal", env: env() })
        expect(blocked.exitCode).toBe(3)
        expect(blocked.stderr).toContain("Goal paused: it needs your decision on the database")

        yield* llm.push(
          reply().text("Fixed the first test").stop(),
          reply().text("CONTINUE: two tests still fail").stop(),
          reply().text("Fixed the second test").stop(),
        )
        const rounds = yield* opencode.run("make the tests pass", {
          command: "goal",
          env: env({ goal: { max_rounds: 1 } }),
        })
        expect(rounds.exitCode).toBe(4)
        expect(rounds.stderr).toContain("Goal paused: It used all 1 rounds (goal.max_rounds).")

        yield* llm.push(reply().text("Said hello").stop(), reply().text("DONE: it said hello").stop())
        const done = yield* opencode.run("say hello", { command: "goal", format: "json", env: env() })
        expect(done.exitCode).toBe(0)
        const last = JSON.parse(done.stdout.trim().split("\n").at(-1)!)
        expect(last).toMatchObject({ type: "result", exit_code: 0, reason: "done", turns: 1 })
      }),
    120_000,
  )
})
