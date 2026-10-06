import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { writeFileSync } from "node:fs"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { runtimeEnv } from "./helpers"

function initialize(home: string) {
  Bun.spawnSync(["git", "init", "-q"], { cwd: home })
  Bun.spawnSync(["git", "config", "user.email", "e2e@example.invalid"], { cwd: home })
  Bun.spawnSync(["git", "config", "user.name", "E2E"], { cwd: home })
  writeFileSync(path.join(home, "modified.txt"), "old\n")
  writeFileSync(path.join(home, "deleted.txt"), "gone\n")
  Bun.spawnSync(["git", "add", "."], { cwd: home })
  Bun.spawnSync(["git", "commit", "-qm", "initial"], { cwd: home })
}

describe("files changed summary", () => {
  cliIt.live(
    "reports one new, one modified, and one deleted file with counts",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        initialize(home)
        yield* llm.push(
          reply().tool("bash", {
            command: "printf 'first\\nsecond\\n' > new.txt; printf 'replacement\\nextra\\n' > modified.txt; rm deleted.txt",
            description: "change three files",
          }),
        )
        yield* llm.text("done")
        const result = yield* opencode.run("change three files", {
          env: runtimeEnv(home),
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("Changed 3 files  +4 −2")
        expect(result.stderr).toContain("deleted.txt (deleted)  −1")
        expect(result.stderr).toContain("modified.txt  +2 −1")
        expect(result.stderr).toContain("new.txt (new)  +2")
      }),
    120_000,
  )

  cliIt.live(
    "--no-summary suppresses a real file change",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        initialize(home)
        yield* llm.push(
          reply().tool("bash", { command: "printf changed > modified.txt", description: "modify a file" }),
        )
        yield* llm.text("done")
        const result = yield* opencode.run("change a file quietly", {
          env: runtimeEnv(home),
          extraArgs: ["--dangerously-skip-permissions", "--no-summary"],
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "modified.txt")).text())).toBe("changed")
        expect(result.stderr).not.toContain("Changed ")
      }),
    120_000,
  )

  cliIt.live(
    "prints no summary when the turn changes no files",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        initialize(home)
        yield* llm.text("nothing changed")
        const result = yield* opencode.run("answer without editing", {
          env: runtimeEnv(home),
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain("Changed ")
        expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: home }).stdout.toString()).toBe("")
      }),
    120_000,
  )
})
