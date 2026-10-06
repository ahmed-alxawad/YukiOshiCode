import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, runtimeEnv } from "./helpers"

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function init(directory: string) {
  git(directory, "init", "-q")
  git(directory, "config", "user.email", "e2e@example.invalid")
  git(directory, "config", "user.name", "E2E")
  Bun.write(path.join(directory, "tracked.txt"), "initial")
  git(directory, "add", "tracked.txt")
  git(directory, "commit", "-qm", "initial")
}

function change(file: string, content: string) {
  return reply().tool("bash", {
    command: `printf %s ${JSON.stringify(content)} > ${JSON.stringify(file)}`,
    description: `write ${content}`,
  })
}

function checkpointID(output: string, message: string) {
  const line = output.split("\n").find((item) => item.includes(message))
  const id = line?.match(/^([0-9a-f]{12})\s/)?.[1]
  if (!id) throw new Error(`Checkpoint ${JSON.stringify(message)} not found in:\n${output}`)
  return id
}

function checkpointLines(output: string) {
  return output.split("\n").filter((line) => /^[0-9a-f]{12}\s/.test(line))
}

function env(home: string, url: string) {
  return {
    ...runtimeEnv(home),
    YUKIOSHI_DB: `${home}-data/checkpoints.db`,
    YUKIOSHI_CONFIG_CONTENT: config(url),
  }
}

describe("git checkpoints", () => {
  cliIt.live(
    "a changed turn creates a checkpoint that list and show accept by printed id",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        Bun.write(path.join(home, "staged.txt"), "keep staged")
        git(home, "add", "staged.txt")
        const head = git(home, "rev-parse", "HEAD")
        const branch = git(home, "branch", "--show-current")
        globalConfig(home, { checkpoints: { enabled: true } })
        yield* llm.push(change(path.join(home, "tracked.txt"), "checkpoint one"))
        yield* llm.text("done")
        const run = yield* opencode.run("create first checkpoint", {
          cwd: home,
          env: env(home, llm.url),
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(run.exitCode).toBe(0)
        expect(git(home, "rev-parse", "HEAD")).toBe(head)
        expect(git(home, "branch", "--show-current")).toBe(branch)
        expect(git(home, "diff", "--cached", "--name-only")).toBe("staged.txt")

        const listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: env(home, llm.url) })
        expect(listed.exitCode).toBe(0)
        const id = checkpointID(listed.stderr, "create first checkpoint")
        const shown = yield* opencode.spawn(["checkpoint", "show", id], { cwd: home, env: env(home, llm.url) })
        expect(shown.exitCode).toBe(0)
        expect(shown.stderr).toContain("create first checkpoint")
        expect(shown.stderr).toContain("checkpoint one")
      }),
    120_000,
  )

  cliIt.live(
    "restore uses printed ids and a safety checkpoint recovers dirty work",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        globalConfig(home, { checkpoints: { enabled: true } })
        const runEnv = env(home, llm.url)

        yield* llm.push(change(path.join(home, "tracked.txt"), "first checkpoint"))
        yield* llm.text("first done")
        expect(
          (yield* opencode.run("first checkpoint turn", {
            cwd: home,
            env: runEnv,
            extraArgs: ["--dangerously-skip-permissions"],
            timeoutMs: 90_000,
          })).exitCode,
        ).toBe(0)
        let listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: runEnv })
        const first = checkpointID(listed.stderr, "first checkpoint turn")

        yield* llm.reset
        yield* llm.push(change(path.join(home, "tracked.txt"), "second checkpoint"))
        yield* llm.text("second done")
        expect(
          (yield* opencode.run("second checkpoint turn", {
            cwd: home,
            env: runEnv,
            extraArgs: ["--dangerously-skip-permissions"],
            timeoutMs: 90_000,
          })).exitCode,
        ).toBe(0)
        Bun.write(path.join(home, "tracked.txt"), "dirty change")

        const refused = yield* opencode.spawn(["checkpoint", "restore", first], { cwd: home, env: runEnv })
        expect(refused.exitCode).toBe(1)
        expect(refused.stderr).toContain("Unsaved changes exist")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "tracked.txt")).text())).toBe("dirty change")
        listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: runEnv })
        expect(checkpointLines(listed.stderr)).toHaveLength(2)

        const restored = yield* opencode.spawn(["checkpoint", "restore", first, "--yes"], {
          cwd: home,
          env: runEnv,
        })
        expect(restored.exitCode).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "tracked.txt")).text())).toBe("first checkpoint")
        listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: runEnv })
        expect(checkpointLines(listed.stderr)).toHaveLength(3)
        const safety = checkpointID(listed.stderr, `Before restoring ${first}`)

        const recovered = yield* opencode.spawn(["checkpoint", "restore", safety, "--yes"], {
          cwd: home,
          env: runEnv,
        })
        expect(recovered.exitCode).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "tracked.txt")).text())).toBe("dirty change")
      }),
    120_000,
  )

  cliIt.live(
    "checkpoints are off by default",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        yield* llm.push(change(path.join(home, "tracked.txt"), "changed without checkpoint"))
        yield* llm.text("done")
        const runEnv = env(home, llm.url)
        const run = yield* opencode.run("change with defaults", {
          cwd: home,
          env: runEnv,
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(run.exitCode).toBe(0)
        expect(git(home, "for-each-ref", "--format=%(refname)", "refs/yukioshi/checkpoints")).toBe("")
        const listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: runEnv })
        expect(listed.exitCode).toBe(0)
        expect(listed.stderr).toContain("No checkpoints.")
      }),
    120_000,
  )

  cliIt.live(
    "outside git a changed turn succeeds without creating a checkpoint",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { checkpoints: { enabled: true } })
        const file = path.join(home, "outside-git.txt")
        yield* llm.push(change(file, "outside git"))
        yield* llm.text("done")
        const runEnv = env(home, llm.url)
        const run = yield* opencode.run("change outside git", {
          cwd: home,
          env: runEnv,
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(run.exitCode).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("outside git")
        const listed = yield* opencode.spawn(["checkpoint", "list"], { cwd: home, env: runEnv })
        expect(listed.exitCode).toBe(1)
        expect(listed.stderr).toContain("not a git repository")
        expect(listed.stderr).not.toContain("Unexpected error")
      }),
    120_000,
  )
})
