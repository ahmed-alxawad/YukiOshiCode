import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, runtimeEnv, waitFor } from "./helpers"

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
const unix = process.platform === "win32" ? describe.skip : describe

unix("scheduled run told to stop", () => {
  cliIt.live(
    "SIGTERM leaves a run log and a recorded result, and does not undo a job added meanwhile",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const pidFile = path.join(home, "sleeper.pid")
        const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url), YUKIOSHI_CRONTAB: path.join(home, "fake-crontab") }
        const add = yield* opencode.spawn(
          ["schedule", "add", "0 0 1 1 *", "hold", "--name", "hold", "--dir", home, "--model", "test/test-model", "--auto"],
          { env },
        )
        const id = (add.stdout + add.stderr).match(/Added scheduled job ([0-9a-f]{8})/)![1]!
        yield* llm.push(
          reply().tool("bash", { command: `echo $$ > ${pidFile}; exec sleep 300`, description: "hold", timeout: 600_000 }),
        )
        const proc = Bun.spawn(["bun", "run", cliEntry, "schedule", "run", id], {
          cwd: home,
          env: {
            ...process.env,
            ...env,
            HOME: home,
            YUKIOSHI_TEST_HOME: home,
            YUKIOSHI_PURE: "1",
            YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
            YUKIOSHI_DISABLE_AUTOUPDATE: "1",
            YUKIOSHI_DISABLE_MODELS_FETCH: "1",
            YUKIOSHI_AUTH_CONTENT: "{}",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        yield* Effect.promise(() =>
          waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the command to start", 30_000),
        )
        const sleeper = Number(fs.readFileSync(pidFile, "utf8").trim())
        // Another job is added while the run is going.
        const second = yield* opencode.spawn(
          ["schedule", "add", "0 0 2 1 *", "other", "--name", "second", "--dir", home, "--model", "test/test-model"],
          { env },
        )
        expect(second.exitCode).toBe(0)
        proc.kill("SIGTERM")
        yield* Effect.promise(() => proc.exited)
        try {
          process.kill(sleeper, "SIGKILL")
        } catch {}

        const jobsFile = `${home}-state/yukioshi/schedule/jobs.json`
        const jobs = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as { id: string; name: string; lastResult?: string }[]
        expect(jobs.map((j) => j.name).sort()).toEqual(["hold", "second"])
        expect(jobs.find((j) => j.id === id)?.lastResult).toContain("interrupted")
        const logs = fs.readdirSync(`${home}-state/yukioshi/schedule/${id}`).filter((name) => name.endsWith(".log"))
        expect(logs.length).toBe(1)
      }),
    90_000,
  )
})
