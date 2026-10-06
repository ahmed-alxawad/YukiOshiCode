import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, requestText, requestToolNames, requestToolResults, runtimeEnv } from "./helpers"

const save = (action: "remember" | "correct", key: string, text: string) =>
  reply().tool("memory_save", { action, key, text })

async function source(home: string, name = "project.md") {
  const files = await Array.fromAsync(
    new Bun.Glob(`yukioshi/memory/**/${name}`).scan({ cwd: `${home}-data`, absolute: true }),
  )
  if (files.length !== 1) throw new Error(`Expected one ${name}, found ${files.length}`)
  return files[0]!
}

describe("memory", () => {
  cliIt.live(
    "a correction is present first in the next request project_memory prompt",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url, { memory: { enabled: true } }),
        }
        yield* llm.push(
          save("remember", "runtime", "Use Bun for every package command."),
          save("correct", "indentation", "Use two spaces and never tabs."),
        )
        yield* llm.text("saved")
        const first = yield* opencode.run("save project guidance", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(first.exitCode).toBe(0)

        yield* llm.reset
        yield* llm.text("remembered")
        const second = yield* opencode.run("what should I remember?", { env })
        expect(second.exitCode).toBe(0)
        const request = (yield* llm.inputs).find((input) => Array.isArray(input.messages))!
        const text = requestText(request)
        expect(text).toContain("<project_memory>")
        expect(text).toContain("Use two spaces and never tabs.")
        expect(text.indexOf("## Corrections")).toBeLessThan(text.indexOf("## Facts"))
      }),
    60_000,
  )

  cliIt.live(
    "an over-limit save is refused, lists entries, and leaves files unchanged",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url, { memory: { enabled: true, max_chars: 70 } }),
        }
        yield* llm.push(save("remember", "a", "a".repeat(30)), save("remember", "b", "b".repeat(30)))
        yield* llm.text("filled")
        const filled = yield* opencode.run("fill memory", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(filled.exitCode).toBe(0)
        const file = yield* Effect.promise(() => source(home))
        const before = yield* Effect.promise(() => Bun.file(file).text())

        yield* llm.reset
        yield* llm.push(save("remember", "c", "c".repeat(30)))
        yield* llm.text("handled")
        const full = yield* opencode.run("add one more memory", {
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(full.exitCode).toBe(0)
        const output = requestToolResults((yield* llm.inputs).at(-1)!).at(-1)!
        expect(output).toContain("Not saved: memory holds 62 of 70 characters")
        expect(output).toContain("- a ::")
        expect(output).toContain("- b ::")
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
      }),
    60_000,
  )

  cliIt.live(
    "a shorter replacement under the same key fits when memory is full",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          save("remember", "a", "a".repeat(40)),
          save("remember", "b", "b".repeat(20)),
          save("remember", "a", "short"),
        )
        yield* llm.text("replaced")
        const result = yield* opencode.run("fill then compact memory", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { memory: { enabled: true, max_chars: 62 } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const outputs = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(outputs.at(-1)).toContain("changed=true")
        const text = yield* Effect.promise(async () => Bun.file(await source(home)).text())
        expect(text).toContain("a :: short")
        expect(text).toContain(`b :: ${"b".repeat(20)}`)
        expect(text).not.toContain("a".repeat(40))
      }),
    60_000,
  )

  cliIt.live(
    "memory is off by default",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("done")
        const result = yield* opencode.run("inspect memory defaults", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        const request = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        const tools = requestToolNames(request)
        expect(tools).not.toContain("memory_save")
        expect(tools).not.toContain("memory_recall")
        expect(requestText(request)).not.toContain("<project_memory>")
      }),
    60_000,
  )
})
