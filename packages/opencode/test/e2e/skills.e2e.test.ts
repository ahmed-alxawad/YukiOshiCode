import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, requestText, requestToolNames, requestToolResults, runtimeEnv } from "./helpers"

function learnedRoot(home: string) {
  return path.join(`${home}-data`, "yukioshi", "skills", "learned")
}

const save = (name: string, description: string, content = "Run the exact release validation steps.") =>
  reply().tool("skill_save", { action: "save", name, description, content })

describe("learned skills", () => {
  cliIt.live(
    "skill_save is listed in a new session and loading the skill increments uses",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url, { skills: { learn: { enabled: true } } }),
        }
        yield* llm.push(save("e2e-release", "Validate the lunar release train before publishing"))
        yield* llm.text("saved")
        const first = yield* opencode.run("learn the release procedure", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(first.exitCode).toBe(0)
        const root = learnedRoot(home)
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "e2e-release", "SKILL.md")).exists())).toBe(true)
        let index = yield* Effect.promise(
          () => Bun.file(path.join(root, "index.json")).json() as Promise<Record<string, { uses: number }>>,
        )
        expect(index["e2e-release"]?.uses).toBe(0)

        yield* llm.reset
        yield* llm.push(reply().tool("skill", { name: "e2e-release" }))
        yield* llm.text("loaded")
        const second = yield* opencode.run("load the learned release procedure", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(second.exitCode).toBe(0)
        const requests = yield* llm.inputs
        const firstRequest = requests.find((input) => requestToolNames(input).includes("skill"))!
        expect(requestText(firstRequest)).toContain("<name>e2e-release</name>")
        expect(requestToolResults(requests.at(-1)!).at(-1)).toContain("# Skill: e2e-release")
        index = yield* Effect.promise(
          () => Bun.file(path.join(root, "index.json")).json() as Promise<Record<string, { uses: number }>>,
        )
        expect(index["e2e-release"]?.uses).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "a near-copy under a new name is refused and no folder is created",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url, { skills: { learn: true } }),
        }
        yield* llm.push(
          save("fix-flaky-cache", "Fix the flaky webpack build cache error on continuous integration"),
          save("cache-flake-fix", "Fix the flaky webpack build cache error in continuous integration"),
        )
        yield* llm.text("finished")
        const result = yield* opencode.run("save both procedures", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const outputs = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(outputs.at(-1)).toContain("similar purpose exists: fix-flaky-cache")
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(learnedRoot(home), "cache-flake-fix", "SKILL.md")).exists(),
          ),
        ).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "the name of a bundled skill is refused",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(save("nightmare", "Replace the bundled adversarial review skill"))
        yield* llm.text("finished")
        const result = yield* opencode.run("save over a bundled skill", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { skills: { learn: true } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).at(-1)).toContain("A skill named nightmare already exists")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(learnedRoot(home), "nightmare", "SKILL.md")).exists()),
        ).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "skill_save is not offered by default",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("done")
        const result = yield* opencode.run("inspect available tools", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        const request = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(request)).not.toContain("skill_save")
      }),
    60_000,
  )
})
