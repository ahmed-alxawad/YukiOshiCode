import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestText, runtimeEnv } from "./helpers"

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

describe("commit and pull request commands", () => {
  cliIt.live(
    "/commit hands the model the commit procedure, and the commit it makes lands",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        git(home, "init", "-q")
        git(home, "config", "user.email", "e2e@example.invalid")
        git(home, "config", "user.name", "E2E")
        fs.writeFileSync(path.join(home, "notes.md"), "first notes\n")

        yield* llm.push(
          reply().tool("bash", {
            command: "git add notes.md && git commit -q -m 'docs: add notes'",
            description: "commit the notes",
          }),
          reply().text("Committed docs: add notes").stop(),
        )
        const result = yield* opencode.run("only the notes file", {
          command: "commit",
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)

        const first = requestText((yield* llm.inputs)[0]!)
        expect(first).toContain("Create a git commit for the current changes")
        expect(first).toContain("only the notes file")
        expect(first).toContain("Never use `git add -A`")
        expect(first).toContain("Do not add co-author trailers")
        expect(git(home, "log", "-1", "--format=%s")).toBe("docs: add notes")
      }),
    60_000,
  )

  cliIt.live(
    "/pr hands the model the pull request procedure with the base branch",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("gh is not signed in; run gh auth login first.")
        const result = yield* opencode.run("develop", {
          command: "pr",
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        const first = requestText((yield* llm.inputs)[0]!)
        expect(first).toContain("Open a pull request for the current branch")
        expect(first).toContain("develop")
        expect(first).toContain("Never force-push")
      }),
    60_000,
  )
})
