import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, requestText, runtimeEnv } from "./helpers"

describe("scheduled tasks e2e", () => {
  cliIt.live(
    "schedule add, list, run creates session and log, logs view, and remove cleans up",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const fakeCrontab = path.join(home, "fake-crontab")
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          YUKIOSHI_CRONTAB: fakeCrontab,
        }

        // 1. Add scheduled job
        const addResult = yield* opencode.spawn(
          [
            "schedule",
            "add",
            "*/5 * * * *",
            "summarize daily updates",
            "--name",
            "daily-summary",
            "--dir",
            home,
            "--model",
            "test/test-model",
            "--auto",
          ],
          { env },
        )
        const addOut = addResult.stdout + addResult.stderr
        expect(addResult.exitCode).toBe(0)
        expect(addOut).toContain("Added scheduled job")
        expect(addOut).toContain("daily-summary")
        expect(addOut).toContain("*/5 * * * *")

        const match = addOut.match(/Added scheduled job ([0-9a-f]{8})/)
        expect(match).not.toBeNull()
        const jobId = match![1]

        // Verify crontab file was created and contains the marked block
        const crontabContent = yield* Effect.promise(() => fs.readFile(fakeCrontab, "utf8"))
        expect(crontabContent).toContain("# BEGIN yukioshi schedule")
        expect(crontabContent).toContain(`*/5 * * * *`)
        expect(crontabContent).toContain(`schedule run ${jobId}`)
        expect(crontabContent).toContain("# END yukioshi schedule")

        // 2. List scheduled jobs
        const listResult = yield* opencode.spawn(["schedule", "list"], { env })
        const listOut = listResult.stdout + listResult.stderr
        expect(listResult.exitCode).toBe(0)
        expect(listOut).toContain(jobId)
        expect(listOut).toContain("daily-summary")
        expect(listOut).toContain("*/5 * * * *")
        expect(listOut).toContain("[enabled]")

        // 3. Run job now
        yield* llm.text("All updates summarized successfully.")
        const runResult = yield* opencode.spawn(["schedule", "run", jobId], { env })
        expect(runResult.exitCode).toBe(0)

        // Verify the model received the prompt
        const inputs = yield* llm.inputs
        const requestsJson = JSON.stringify(inputs)
        expect(requestsJson).toContain("summarize daily updates")

        // 4. View logs
        const logsResult = yield* opencode.spawn(["schedule", "logs", jobId, "--last"], { env })
        const logsOut = logsResult.stdout + logsResult.stderr
        expect(logsResult.exitCode).toBe(0)
        expect(logsOut).toContain(`Starting scheduled job "daily-summary" (${jobId})`)
        expect(logsOut).toContain("summarize daily updates")

        // 5. Remove job
        const removeResult = yield* opencode.spawn(["schedule", "remove", jobId], { env })
        const removeOut = removeResult.stdout + removeResult.stderr
        expect(removeResult.exitCode).toBe(0)
        expect(removeOut).toContain(`Removed scheduled job ${jobId}`)

        // Verify crontab block was cleaned up
        const crontabAfter = yield* Effect.promise(() => fs.readFile(fakeCrontab, "utf8").catch(() => ""))
        expect(crontabAfter).not.toContain("# BEGIN yukioshi schedule")

        // 6. List jobs confirms empty
        const listAfter = yield* opencode.spawn(["schedule", "list"], { env })
        const listAfterOut = listAfter.stdout + listAfter.stderr
        expect(listAfter.exitCode).toBe(0)
        expect(listAfterOut).toContain("No scheduled jobs.")
      }),
    60_000,
  )

  cliIt.live(
    "a run blocked by spending limits logs skipped: budget",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { budget: { tokens: { daily: 10 } } })
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_DB: `${home}-data/budget.db`,
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          YUKIOSHI_CRONTAB: path.join(home, "fake-crontab"),
        }

        // Exhaust daily budget with an initial prompt
        yield* llm.text("first session", { usage: { input: 6, output: 6 } })
        const firstRun = yield* opencode.run("seed session", { env })
        expect(firstRun.exitCode).toBe(0)

        // Add scheduled job
        const addResult = yield* opencode.spawn(
          [
            "schedule",
            "add",
            "0 9 * * *",
            "check budget run",
            "--name",
            "budget-job",
            "--dir",
            home,
            "--model",
            "test/test-model",
            "--auto",
          ],
          { env },
        )
        const addOut = addResult.stdout + addResult.stderr
        const match = addOut.match(/Added scheduled job ([0-9a-f]{8})/)
        expect(match).not.toBeNull()
        const jobId = match![1]

        // Run scheduled job when budget is exceeded
        const runResult = yield* opencode.spawn(["schedule", "run", jobId], { env })
        const runOut = runResult.stdout + runResult.stderr
        expect(runResult.exitCode).toBe(0)
        expect(runOut).toContain("spending limit (budget) reached")

        // Verify logs show skipped: budget
        const logsResult = yield* opencode.spawn(["schedule", "logs", jobId, "--last"], { env })
        const logsOut = logsResult.stdout + logsResult.stderr
        expect(logsOut).toContain("skipped: budget")

        // Verify schedule list reflects skipped: budget
        const listResult = yield* opencode.spawn(["schedule", "list"], { env })
        const listOut = listResult.stdout + listResult.stderr
        expect(listOut).toContain("[last: skipped: budget]")
      }),
    60_000,
  )
  cliIt.live(
    "a --review job has the reviewer decide its actions",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          YUKIOSHI_CRONTAB: path.join(home, "fake-crontab"),
        }
        const both = yield* opencode.spawn(["schedule", "add", "0 9 * * *", "x", "--auto", "--review"], { env })
        expect(both.exitCode).not.toBe(0)
        expect(both.stderr).toContain("Use either --auto or --review, not both.")

        const added = yield* opencode.spawn(
          ["schedule", "add", "0 9 * * *", "tidy the notes", "--dir", home, "--model", "test/test-model", "--review"],
          { env },
        )
        expect(added.exitCode).toBe(0)
        const jobId = (added.stdout + added.stderr).match(/Added scheduled job ([0-9a-f]{8})/)![1]!

        const fromReviewer = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("<action>")
        yield* llm.pushMatch(
          (hit) => !fromReviewer(hit),
          reply().tool("bash", { command: "touch reviewed-file", description: "create a file" }),
          reply().text("finished").stop(),
        )
        yield* llm.pushMatch(fromReviewer, reply().text("DENY: the request did not ask for a new file").stop())
        const run = yield* opencode.spawn(["schedule", "run", jobId], { env })
        expect(run.exitCode).toBe(0)
        expect(existsSync(path.join(home, "reviewed-file"))).toBe(false)
        const reviews = (yield* llm.inputs).filter((input) => requestText(input).includes("<action>"))
        expect(reviews).toHaveLength(1)
        expect(requestText(reviews[0]!)).toContain("tidy the notes")
      }),
    90_000,
  )
})
