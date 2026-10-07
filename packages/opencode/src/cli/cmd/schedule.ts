import type { Argv } from "yargs"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { randomBytes } from "crypto"
import { cmd } from "./cmd"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { errorMessage } from "../../util/error"
import { UI } from "../ui"
import {
  validateCron,
  nextRun,
  loadJobs,
  saveJobs,
  findJob,
  getRunLogs,
  syncSystemSchedule,
  runJob,
  type ScheduleJob,
} from "../../schedule"

const cliTry = <Value>(message: string, fn: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => new CliError({ message: message + errorMessage(error) }),
  })

function generateId(): string {
  return randomBytes(4).toString("hex")
}

export const ScheduleAddCommand = effectCmd({
  command: "add <cron> <prompt>",
  describe: "schedule a prompt to run on a recurring cron schedule",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("cron", {
        type: "string",
        demandOption: true,
        describe: "standard 5-field cron expression",
      })
      .positional("prompt", {
        type: "string",
        demandOption: true,
        describe: "prompt to execute on schedule",
      })
      .option("name", {
        type: "string",
        describe: "display name for the scheduled task",
      })
      .option("dir", {
        type: "string",
        describe: "target directory for task execution (defaults to current directory)",
      })
      .option("model", {
        type: "string",
        describe: "model to execute the prompt with (provider/model)",
      })
      .option("agent", {
        type: "string",
        describe: "agent mode to execute with",
      })
      .option("auto", {
        type: "boolean",
        default: false,
        describe: "automatically approve permission requests during runs",
      })
      .option("review", {
        type: "boolean",
        default: false,
        describe: "have a small model approve or refuse each action that is not low-risk (permission mode review)",
      }),
  handler: Effect.fn("Cli.schedule.add")(function* (args: {
    cron: string
    prompt: string
    name?: string
    dir?: string
    model?: string
    agent?: string
    auto: boolean
    review: boolean
  }) {
    if (args.auto && args.review) return yield* fail("Use either --auto or --review, not both.")
    // 1. Validate cron expression
    let parsedCron
    try {
      parsedCron = validateCron(args.cron)
    } catch (err: any) {
      return yield* fail(err.message)
    }

    const targetDir = path.resolve(args.dir ?? process.cwd())
    const id = generateId()
    const name = args.name?.trim() || args.prompt.trim().slice(0, 30) || `job-${id}`

    const newJob: ScheduleJob = {
      id,
      name,
      cron: parsedCron.raw,
      prompt: args.prompt,
      directory: targetDir,
      model: args.model,
      agent: args.agent,
      auto: Boolean(args.auto),
      ...(args.review ? { review: true } : {}),
      enabled: true,
      createdAt: Date.now(),
    }

    const jobs = yield* cliTry("Failed to load jobs: ", () => loadJobs())
    jobs.push(newJob)

    yield* cliTry("Failed to save scheduled jobs: ", () => saveJobs(jobs))
    yield* cliTry("Failed to update system scheduler: ", () => syncSystemSchedule(jobs))

    const next = localTime(nextRun(parsedCron))
    UI.println(`Added scheduled job ${newJob.id} (${newJob.name})`)
    UI.println(`Schedule: ${newJob.cron} (next run: ${next})`)
    UI.println(`Directory: ${newJob.directory}`)
    const keys = envOnlyKeys()
    if (process.platform !== "win32" && keys.length > 0)
      UI.println(
        `Note: scheduled runs do not load your shell profile, so ${keys.join(", ")} will not be set for them. Store keys with \`yukioshi providers login\` so scheduled runs can use them.`,
      )
  }),
})

export const ScheduleListCommand = effectCmd({
  command: "list",
  describe: "list all scheduled jobs",
  instance: false,
  handler: Effect.fn("Cli.schedule.list")(function* () {
    const jobs = yield* cliTry("Failed to load jobs: ", () => loadJobs())
    if (jobs.length === 0) {
      UI.println("No scheduled jobs.")
      return
    }

    for (const job of jobs) {
      let nextStr = "disabled"
      if (job.enabled) {
        try {
          nextStr = localTime(nextRun(job.cron))
        } catch {
          nextStr = "invalid schedule"
        }
      }
      const status = job.enabled ? "enabled" : "disabled"
      const resultPart = job.lastResult ? `  [last: ${job.lastResult}]` : ""
      UI.println(
        `${job.id}  "${job.name}"  ${job.cron}  next: ${nextStr}  dir: ${job.directory}  [${status}]${resultPart}`,
      )
    }
  }),
})

export const ScheduleRemoveCommand = effectCmd({
  command: "remove <id>",
  describe: "remove a scheduled job",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "id of the job to remove",
    }),
  handler: Effect.fn("Cli.schedule.remove")(function* (args: { id: string }) {
    const jobs = yield* cliTry("Failed to load jobs: ", () => loadJobs())
    const index = jobs.findIndex((j) => j.id === args.id || (args.id.length >= 6 && j.id.startsWith(args.id)))
    if (index === -1) {
      return yield* fail(`Scheduled job not found: ${args.id}`)
    }

    const removed = jobs.splice(index, 1)[0]
    yield* cliTry("Failed to save jobs: ", () => saveJobs(jobs))
    yield* cliTry("Failed to update system scheduler: ", () => syncSystemSchedule(jobs))

    UI.println(`Removed scheduled job ${removed.id} (${removed.name}).`)
  }),
})

export const ScheduleRunCommand = effectCmd({
  command: "run <id>",
  describe: "run a scheduled job immediately",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "id of the job to run",
    }),
  handler: Effect.fn("Cli.schedule.run")(function* (args: { id: string }) {
    const job = yield* cliTry("Failed to find job: ", () => findJob(args.id))
    if (!job) {
      return yield* fail(`Scheduled job not found: ${args.id}`)
    }

    const result = yield* cliTry("Job execution failed: ", () => runJob(job.id))

    if (result.status === "skipped: already running") {
      UI.println("Job is already running. Skipped.")
    } else if (result.status === "skipped: budget") {
      UI.println("Job run skipped: spending limit (budget) reached.")
    } else if (result.status === "skipped: disabled") {
      UI.println("Job is disabled. Skipped.")
    } else if (result.status === "failed") {
      return yield* fail(`Job failed: ${result.error ?? "unknown error"}`)
    } else {
      UI.println(`Job ${job.id} (${job.name}) finished successfully.`)
    }
  }),
})

export const ScheduleLogsCommand = effectCmd({
  command: "logs <id>",
  describe: "view logs of past runs for a scheduled job",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("id", {
        type: "string",
        demandOption: true,
        describe: "id of the job",
      })
      .option("last", {
        type: "boolean",
        default: false,
        describe: "show only the output of the most recent run",
      }),
  handler: Effect.fn("Cli.schedule.logs")(function* (args: { id: string; last: boolean }) {
    const job = yield* cliTry("Failed to find job: ", () => findJob(args.id))
    if (!job) {
      return yield* fail(`Scheduled job not found: ${args.id}`)
    }

    const logs = yield* cliTry("Failed to load logs: ", () => getRunLogs(job.id))
    if (logs.length === 0) {
      UI.println(`No logs found for job ${job.id}.`)
      return
    }

    if (args.last) {
      const content = yield* cliTry("Failed to read log file: ", () => fs.readFile(logs[0].path, "utf8"))
      process.stdout.write(content + "\n")
      return
    }

    // Default: output the most recent run's log content, and note count if multiple
    const latest = logs[0]
    const content = yield* cliTry("Failed to read log file: ", () => fs.readFile(latest.path, "utf8"))
    process.stdout.write(content + "\n")
    if (logs.length > 1) {
      UI.println(`\n[${logs.length} past runs available for job ${job.id}. Showing most recent: ${latest.filename}]`)
    }
  }),
})

export const ScheduleEnableCommand = effectCmd({
  command: "enable <id>",
  describe: "enable a scheduled job",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "id of the job to enable",
    }),
  handler: Effect.fn("Cli.schedule.enable")(function* (args: { id: string }) {
    const jobs = yield* cliTry("Failed to load jobs: ", () => loadJobs())
    const job = jobs.find((j) => j.id === args.id || (args.id.length >= 6 && j.id.startsWith(args.id)))
    if (!job) {
      return yield* fail(`Scheduled job not found: ${args.id}`)
    }

    job.enabled = true
    yield* cliTry("Failed to save jobs: ", () => saveJobs(jobs))
    yield* cliTry("Failed to update system scheduler: ", () => syncSystemSchedule(jobs))

    UI.println(`Enabled scheduled job ${job.id} (${job.name}).`)
  }),
})

export const ScheduleDisableCommand = effectCmd({
  command: "disable <id>",
  describe: "disable a scheduled job",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      type: "string",
      demandOption: true,
      describe: "id of the job to disable",
    }),
  handler: Effect.fn("Cli.schedule.disable")(function* (args: { id: string }) {
    const jobs = yield* cliTry("Failed to load jobs: ", () => loadJobs())
    const job = jobs.find((j) => j.id === args.id || (args.id.length >= 6 && j.id.startsWith(args.id)))
    if (!job) {
      return yield* fail(`Scheduled job not found: ${args.id}`)
    }

    job.enabled = false
    yield* cliTry("Failed to save jobs: ", () => saveJobs(jobs))
    yield* cliTry("Failed to update system scheduler: ", () => syncSystemSchedule(jobs))

    UI.println(`Disabled scheduled job ${job.id} (${job.name}).`)
  }),
})

export const ScheduleCommand = cmd({
  command: "schedule",
  describe: "manage scheduled tasks and recurring runs",
  builder: (yargs: Argv) =>
    yargs
      .command(ScheduleAddCommand)
      .command(ScheduleListCommand)
      .command(ScheduleRemoveCommand)
      .command(ScheduleRunCommand)
      .command(ScheduleLogsCommand)
      .command(ScheduleEnableCommand)
      .command(ScheduleDisableCommand)
      .demandCommand(1, "Please specify a schedule action (add, list, remove, run, logs, enable, disable)"),
  async handler() {},
})

/** "2026-10-07 09:00 Asia/Dhaka": cron schedules are in local time, so show the next run the same way. */
function localTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone}`
}

/** Provider keys that exist only as environment variables here; cron will not see them. */
function envOnlyKeys(env: Record<string, string | undefined> = process.env) {
  return Object.keys(env)
    .filter((name) => /_API_KEY$|^(GITHUB|GH)_TOKEN$/.test(name) && env[name])
    .sort()
}
