import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, runtimeEnv } from "./helpers"

describe("goal", () => {
  cliIt.live("runs a goal through continuation and stores the completed state", ({ home, llm, opencode }) => Effect.gen(function* () {
    yield* llm.push(
      reply().text("I started the work").stop(),
      reply().text("CONTINUE: one verification step remains").stop(),
      reply().text("The verification is complete").stop(),
      reply().text("DONE: the goal is complete").stop(),
    )

    const result = yield* opencode.run("finish the verification", {
      command: "goal",
      format: "json",
      env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { goal: { max_rounds: 2 } }) },
    })
    expect(result.exitCode).toBe(0)

    const requests = yield* llm.inputs
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[2])).toContain("Continue working toward the goal (round 1 of 2)")
    expect(JSON.stringify(requests[2])).toContain("one verification step remains")

    const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("**/*.json").scan({ cwd: `${home}-state` })))
    const goalFile = files.find((file) => file.includes("goals/"))
    expect(goalFile).toBeDefined()
    const goal = JSON.parse(yield* Effect.promise(() => Bun.file(`${home}-state/${goalFile}`).text())) as Record<string, unknown>
    expect(goal).toMatchObject({ status: "done", rounds: 1, note: "the goal is complete" })
  }), 60_000)

  cliIt.live("edits file A in the first round and file B in the second and lists both in summary", ({ home, llm, opencode }) => Effect.gen(function* () {
    Bun.spawnSync(["git", "init", "-q"], { cwd: home })
    Bun.spawnSync(["git", "config", "user.email", "e2e@example.invalid"], { cwd: home })
    Bun.spawnSync(["git", "config", "user.name", "E2E"], { cwd: home })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-qm", "initial"], { cwd: home })

    yield* llm.push(
      reply().tool("bash", { command: "printf 'alpha\\n' > a.txt", description: "edit file a" }),
      reply().text("edited a").stop(),
      reply().text("CONTINUE: edit b").stop(),
      reply().tool("bash", { command: "printf 'beta\\n' > b.txt", description: "edit file b" }),
      reply().text("edited b").stop(),
      reply().text("DONE: complete").stop(),
    )

    const result = yield* opencode.run("edit files across rounds", {
      command: "goal",
      extraArgs: ["--dangerously-skip-permissions"],
      env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { goal: { max_rounds: 2 } }) },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Changed 2 files")
    expect(result.stderr).toContain("a.txt (new)")
    expect(result.stderr).toContain("b.txt (new)")
  }), 60_000)
})
