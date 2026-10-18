import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

function repo(home: string) {
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: home })
  run("init", "-q")
  fs.writeFileSync(path.join(home, ".gitignore"), "ignored.ts\n")
  fs.writeFileSync(path.join(home, "a.ts"), "export const a = 1\n")
  fs.writeFileSync(path.join(home, "ignored.ts"), "export const b = 1\n")
}

const envFor = (home: string, url: string) => ({
  ...runtimeEnv(home),
  YUKIOSHI_CONFIG_CONTENT: config(url),
})

const realCalls = (inputs: Record<string, unknown>[]) =>
  inputs.filter((input) => !JSON.stringify(input).includes("Generate a title for this conversation"))

/** Starts `watch` with --once, edits files after it is listening, and returns its result. */
function watchWith(
  opencode: { spawn: (args: string[], opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number }) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }> },
  home: string,
  env: Record<string, string>,
  args: string[],
  edit: () => void,
) {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(opencode.spawn(["watch", ...args], { cwd: home, env, timeoutMs: 45_000 }))
    yield* Effect.sleep("2500 millis")
    edit()
    // A slow start can miss the first edit: touch files that still carry a marker until the command exits.
    const touch = yield* Effect.forkChild(
      Effect.forever(
        Effect.sleep("1500 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              for (const name of ["a.ts", "ignored.ts"]) {
                const file = path.join(home, name)
                const text = fs.readFileSync(file, "utf8")
                if (/AI[!?]/.test(text)) fs.writeFileSync(file, text)
              }
            }),
          ),
        ),
      ),
    )
    const result = yield* Fiber.join(fiber)
    yield* Fiber.interrupt(touch)
    return result
  })
}

describe("watch", () => {
  cliIt.live("an AI! comment triggers exactly one run and the marker is removed", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const env = envFor(home, llm.url)
      expect((yield* opencode.spawn(["trust", home], { cwd: home, env })).exitCode).toBe(0)
      yield* llm.text("done")
      const result = yield* watchWith(opencode, home, env, ["--once", "--model", "test/test-model"], () =>
        fs.appendFileSync(path.join(home, "a.ts"), "// rename a to b AI!\n"),
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("a.ts:2")
      const calls = realCalls(yield* llm.inputs)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0])).toContain("rename a to b")
      expect(fs.readFileSync(path.join(home, "a.ts"), "utf8")).toBe("export const a = 1\n// rename a to b\n")
    }), 60_000)

  cliIt.live("gitignored files are ignored", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const env = envFor(home, llm.url)
      yield* opencode.spawn(["trust", home], { cwd: home, env })
      yield* llm.text("done")
      const result = yield* watchWith(opencode, home, env, ["--once", "--dry-run"], () => {
        fs.appendFileSync(path.join(home, "ignored.ts"), "// secret AI!\n")
        setTimeout(() => fs.appendFileSync(path.join(home, "a.ts"), "// visible AI!\n"), 800)
      })
      expect(result.stderr).toContain("visible")
      expect(result.stderr).not.toContain("secret")
    }), 60_000)

  cliIt.live("an AI? comment gets the answer written as a comment below", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const env = envFor(home, llm.url)
      yield* opencode.spawn(["trust", home], { cwd: home, env })
      yield* llm.text("It is one.")
      const result = yield* watchWith(opencode, home, env, ["--once", "--model", "test/test-model"], () =>
        fs.appendFileSync(path.join(home, "a.ts"), "// what is a? AI?\n"),
      )
      expect(result.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(home, "a.ts"), "utf8")).toBe(
        "export const a = 1\n// what is a?\n// It is one.\n",
      )
    }), 60_000)

  cliIt.live("an untrusted repository is refused", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const result = yield* opencode.spawn(["watch", "--once"], { cwd: home, env: envFor(home, llm.url) })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("not trusted")
      expect(yield* llm.calls).toBe(0)
    }), 60_000)

  cliIt.live("--dry-run prints the trigger and runs nothing", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const env = envFor(home, llm.url)
      yield* opencode.spawn(["trust", home], { cwd: home, env })
      yield* llm.text("must not be used")
      const result = yield* watchWith(opencode, home, env, ["--once", "--dry-run", "--model", "test/test-model"], () =>
        fs.appendFileSync(path.join(home, "a.ts"), "# do it AI!\n"),
      )
      expect(result.stderr).toContain("would run")
      expect(yield* llm.calls).toBe(0)
      expect(fs.readFileSync(path.join(home, "a.ts"), "utf8")).toContain("# do it AI!")
    }), 60_000)

  cliIt.live("auto-all is refused", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      repo(home)
      const result = yield* opencode.spawn(["watch", "--mode", "auto-all"], { cwd: home, env: envFor(home, llm.url) })
      expect(result.exitCode).not.toBe(0)
    }), 60_000)
})
