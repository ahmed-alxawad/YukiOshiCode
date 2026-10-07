import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, runtimeEnv } from "./helpers"

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function init(directory: string) {
  git(directory, "init", "-q")
  git(directory, "config", "user.email", "e2e@example.invalid")
  git(directory, "config", "user.name", "E2E")
  fs.writeFileSync(path.join(directory, "base.txt"), "base")
  git(directory, "add", "base.txt")
  git(directory, "commit", "-qm", "base")
}

function env(home: string, url: string) {
  return { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(url) }
}

describe("worktrees", () => {
  cliIt.live(
    "run --worktree works in its own checkout and leaves the main folder untouched",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        const runEnv = env(home, llm.url)

        const created = yield* opencode.spawn(["worktree", "new", "Feature X"], { cwd: home, env: runEnv })
        expect(created.exitCode).toBe(0)
        expect(created.stderr).toContain("Created worktree feature-x on branch yukioshi/feature-x.")

        // `path` prints on stdout so it can be used as cd "$(yukioshi worktree path feature-x)".
        const located = yield* opencode.spawn(["worktree", "path", "feature-x"], { cwd: home, env: runEnv })
        const directory = located.stdout.trim()
        expect(fs.readFileSync(path.join(directory, "base.txt"), "utf8")).toBe("base")
        expect(git(directory, "branch", "--show-current")).toBe("yukioshi/feature-x")

        // A relative path: it only lands in the worktree if the session really runs there.
        const target = path.join(directory, "made.txt")
        yield* llm.push(
          reply().tool("bash", { command: "printf %s 'made in the worktree' > made.txt", description: "write a file" }),
        )
        yield* llm.text("done")
        const run = yield* opencode.run("add a file", {
          cwd: home,
          env: runEnv,
          extraArgs: ["--worktree", "feature-x", "--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(run.exitCode).toBe(0)
        expect(run.stderr).toContain("Using worktree feature-x (yukioshi/feature-x)")
        expect(fs.readFileSync(target, "utf8")).toBe("made in the worktree")
        expect(fs.existsSync(path.join(home, "made.txt"))).toBe(false)
        expect(git(home, "status", "--short")).toBe("")
      }),
    120_000,
  )

  cliIt.live(
    "remove refuses to lose uncommitted or unmerged work, and --yes removes worktree and branch",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        const runEnv = env(home, llm.url)
        expect((yield* opencode.spawn(["worktree", "new", "risky"], { cwd: home, env: runEnv })).exitCode).toBe(0)
        const directory = (yield* opencode.spawn(["worktree", "path", "risky"], { cwd: home, env: runEnv })).stdout.trim()

        fs.writeFileSync(path.join(directory, "work.txt"), "unsaved")
        const dirty = yield* opencode.spawn(["worktree", "remove", "risky"], { cwd: home, env: runEnv })
        expect(dirty.exitCode).not.toBe(0)
        expect(dirty.stderr).toContain("has 1 uncommitted change")
        expect(fs.existsSync(path.join(directory, "work.txt"))).toBe(true)

        git(directory, "add", "work.txt")
        git(directory, "commit", "-qm", "worktree work")
        const unmerged = yield* opencode.spawn(["worktree", "remove", "risky"], { cwd: home, env: runEnv })
        expect(unmerged.exitCode).not.toBe(0)
        expect(unmerged.stderr).toContain("has 1 commit on yukioshi/risky not on your current branch")

        const removed = yield* opencode.spawn(["worktree", "remove", "risky", "--yes"], { cwd: home, env: runEnv })
        expect(removed.exitCode).toBe(0)
        expect(removed.stderr).toContain("Removed worktree risky and its branch yukioshi/risky.")
        expect(fs.existsSync(directory)).toBe(false)
        expect(git(home, "branch", "--list", "yukioshi/*")).toBe("")
      }),
    120_000,
  )

  cliIt.live(
    "outside a git repository it says worktrees need git",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), "yk-no-git-"))
        const result = yield* opencode.spawn(["worktree", "new", "x"], { cwd: plain, env: env(home, llm.url) })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Worktrees are only supported for git projects")
      }),
    60_000,
  )
})
