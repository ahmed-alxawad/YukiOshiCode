import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, runtimeEnv, waitFor } from "./helpers"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const unix = process.platform === "win32" ? describe.skip : describe

unix("scheduled run time limit", () => {
  cliIt.live(
    "a run that never ends is stopped at the limit, its command is killed, and the job log says why",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const pidFile = path.join(home, "sleeper.pid")
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          YUKIOSHI_CRONTAB: path.join(home, "fake-crontab"),
          YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS: "5",
        }
        const add = yield* opencode.spawn(
          ["schedule", "add", "0 0 1 1 *", "hold", "--name", "hold", "--dir", home, "--model", "test/test-model", "--auto"],
          { env },
        )
        expect(add.exitCode).toBe(0)
        const id = (add.stdout + add.stderr).match(/Added scheduled job ([0-9a-f]{8})/)![1]
        yield* llm.push(
          reply().tool("bash", { command: `echo $$ > ${pidFile}; exec sleep 300`, description: "hold", timeout: 600_000 }),
        )
        const started = Date.now()
        const run = yield* opencode.spawn(["schedule", "run", id!], { env, timeoutMs: 60_000 })
        const elapsed = Date.now() - started
        expect(elapsed).toBeLessThan(40_000)
        const out = run.stdout + run.stderr
        expect(out).toContain("failed")
        expect(out).toContain("YUKIOSHI_SCHEDULE_MAX_RUN_SECONDS")
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
        yield* Effect.promise(() => waitFor(() => !alive(pid), `sleeper ${pid} to be gone`, 5_000))
      }),
    90_000,
  )
})
