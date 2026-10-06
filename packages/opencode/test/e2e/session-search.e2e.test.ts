import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, requestText, requestToolResults, runtimeEnv } from "./helpers"

function conversation(inputs: Record<string, unknown>[]) {
  return inputs.filter((input) => !requestText(input).includes("Generate a title for this conversation"))
}

describe("session_search", () => {
  cliIt.live(
    "finds an earlier session by a unique keyword and returns its snippet",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_DB: `${home}-data/session-search.db`,
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
        }
        const keyword = "violet-orbit-7319"
        yield* llm.text("saved")
        const seeded = yield* opencode.run(`The earlier decision was ${keyword} with a blue release train.`, { env })
        expect(seeded.exitCode).toBe(0)

        yield* llm.reset
        yield* llm.push(reply().tool("session_search", { query: keyword, scope: "project" }))
        yield* llm.text("search complete")
        const result = yield* opencode.run("find the earlier decision", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const inputs = conversation(yield* llm.inputs)
        expect(inputs).toHaveLength(2)
        expect(requestText(inputs[1]!)).toContain(`The earlier decision was ${keyword}`)
        expect(requestText(inputs[1]!)).toContain(`Session: The earlier decision was ${keyword}`)
      }),
    60_000,
  )

  cliIt.live(
    "never returns the current session",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const keyword = "current-only-8821"
        yield* llm.push(reply().tool("session_search", { query: keyword, scope: "project" }))
        yield* llm.text("search complete")
        const result = yield* opencode.run(`Search for ${keyword}, which exists only in this message`, {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_DB: `${home}-data/current-search.db`,
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const inputs = conversation(yield* llm.inputs)
        expect(requestToolResults(inputs.at(-1)!).at(-1)).toBe(`No sessions matched "${keyword}".`)
      }),
    60_000,
  )

  cliIt.live(
    'is project-only by default and scope "all" finds another project',
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const current = path.join(home, "current-project")
        const other = path.join(home, "other-project")
        Bun.spawnSync(["mkdir", "-p", current, other])
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(current, ".keep"), "current"),
            Bun.write(path.join(other, ".keep"), "other"),
          ]),
        )
        for (const cwd of [current, other]) {
          Bun.spawnSync(["git", "init", "-q"], { cwd })
          Bun.spawnSync(["git", "add", "."], { cwd })
          Bun.spawnSync(
            ["git", "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "initial"],
            { cwd },
          )
        }
        const common = {
          ...runtimeEnv(home),
          YUKIOSHI_DB: `${home}-data/cross-project-search.db`,
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
        }
        const keyword = "cross-project-citrine-4492"

        yield* llm.text("stored")
        const seeded = yield* opencode.run(`Only the other project contains ${keyword}.`, {
          cwd: other,
          env: { ...common, PWD: other },
        })
        expect(seeded.exitCode).toBe(0)

        yield* llm.reset
        yield* llm.push(reply().tool("session_search", { query: keyword }))
        yield* llm.text("project search complete")
        const local = yield* opencode.run("search this project", {
          cwd: current,
          env: { ...common, PWD: current },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(local.exitCode).toBe(0)
        let inputs = conversation(yield* llm.inputs)
        expect(requestToolResults(inputs.at(-1)!).at(-1)).toBe(`No sessions matched "${keyword}".`)

        yield* llm.reset
        yield* llm.push(reply().tool("session_search", { query: keyword, scope: "all" }))
        yield* llm.text("all-project search complete")
        const all = yield* opencode.run("search every project", {
          cwd: current,
          env: { ...common, PWD: current },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(all.exitCode).toBe(0)
        inputs = conversation(yield* llm.inputs)
        expect(requestText(inputs.at(-1)!)).toContain(`Only the other project contains ${keyword}.`)
      }),
    120_000,
  )
})
