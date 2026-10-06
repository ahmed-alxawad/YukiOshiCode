import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { globalConfig, runtimeEnv } from "./helpers"

describe("git checkpoints", () => {
  cliIt.live("creates a separate-ref checkpoint after a real changed turn", ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      Bun.spawnSync(["git", "init", "-q"], { cwd: home })
      Bun.spawnSync(["git", "config", "user.email", "e2e@example.invalid"], { cwd: home })
      Bun.spawnSync(["git", "config", "user.name", "E2E"], { cwd: home })
      Bun.write(`${home}/tracked.txt`, "before")
      Bun.spawnSync(["git", "add", "."], { cwd: home })
      Bun.spawnSync(["git", "commit", "-qm", "initial"], { cwd: home })
      globalConfig(home, { checkpoints: { enabled: true } })
      const env = { ...runtimeEnv(home), YUKIOSHI_DB: `${home}-data/checkpoints.db` }
      yield* llm.push(reply().tool("bash", { command: `printf after > ${JSON.stringify(`${home}/tracked.txt`)}`, description: "edit" }))
      yield* llm.text("done")
      const run = yield* opencode.run("update the file", { env, extraArgs: ["--dangerously-skip-permissions"] })
      expect(run.exitCode).toBe(0)
      const listed = yield* opencode.spawn(["checkpoint", "list"], { env })
      expect(listed.exitCode).toBe(0)
      expect(listed.stderr).toContain("update the file")
      const refs = Bun.spawnSync(["git", "for-each-ref", "--format=%(refname)", "refs/yukioshi/checkpoints"], { cwd: home, stdout: "pipe" }).stdout.toString()
      expect(refs).toContain("refs/yukioshi/checkpoints/")
    }),
    60_000,
  )
})
