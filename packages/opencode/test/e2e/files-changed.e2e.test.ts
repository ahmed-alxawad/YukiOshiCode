import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { runtimeEnv } from "./helpers"

describe("files changed summary", () => {
  cliIt.live(
    "reports new files and supports --no-summary",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        Bun.spawnSync(["git", "init"], { cwd: home })
        Bun.spawnSync(["git", "config", "user.email", "e2e@example.invalid"], { cwd: home })
        Bun.spawnSync(["git", "config", "user.name", "E2E"], { cwd: home })
        Bun.write(`${home}/.gitkeep`, "")
        Bun.spawnSync(["git", "add", "."], { cwd: home })
        Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: home })
        yield* llm.push(
          reply().tool("bash", { command: `printf hi > ${JSON.stringify(`${home}/new.txt`)}`, description: "create" }),
        )
        yield* llm.text("done")
        const first = yield* opencode.run("create a file", {
          env: runtimeEnv(home),
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 50_000,
        })
        expect(first.exitCode).toBe(0)
        expect(first.stderr).toContain("Changed 1 file")
        expect(first.stderr).toContain("new.txt")
        yield* llm.reset
        yield* llm.text("done")
        const second = yield* opencode.run("say done", {
          env: runtimeEnv(home),
          extraArgs: ["--no-summary"],
          timeoutMs: 50_000,
        })
        expect(second.exitCode).toBe(0)
        expect(second.stderr).not.toContain("Changed ")
      }),
    60_000,
  )
})
