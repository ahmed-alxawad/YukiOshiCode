import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Audit } from "@/audit"
import { Config } from "@/config/config"
import { BackgroundShell } from "@/background/shell"

/** Background shell is off until the config turns it on, or YUKIOSHI_BACKGROUND_SHELL is set. */
export function backgroundShell(flags: { readonly backgroundShell: boolean }, cfg: { readonly background_shell?: { readonly enabled?: boolean } }) {
  return flags.backgroundShell || cfg.background_shell?.enabled === true
}

/** One line in the audit log for a background job: start, stop (by the agent) or exit. */
export async function auditJob(
  event: "start" | "stop" | "exit",
  job: BackgroundShell.Job,
  cfg: { readonly audit?: { readonly enabled?: boolean } },
) {
  if (cfg.audit?.enabled !== true) return
  await Audit.writeEntry(
    {
      event: `background_shell.${event}`,
      session: job.sessionID,
      job: job.id,
      command: job.command.slice(0, 500),
      ...(event === "exit" ? { state: job.state, exit: job.exit } : {}),
    },
    job.cwd,
  ).catch(() => undefined)
}

function age(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

function status(job: Pick<BackgroundShell.Info, "state" | "exit">) {
  if (job.state === "exited") return `exited with code ${job.exit ?? "unknown"}`
  return job.state
}

const MAX_WAIT_SECONDS = 600
const MAX_TEXT = 30_000

const MonitorParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The job id returned when the job was started" }),
  until: Schema.optional(Schema.String).annotate({
    description:
      "A regular expression. Wait until a new line matches it, or the job ends, or the timeout passes. Without it, a positive timeout waits for any new output.",
  }),
  match: Schema.optional(Schema.String).annotate({
    description: "A regular expression. Return only the new lines that match it.",
  }),
  timeout_seconds: Schema.optional(Schema.Number).annotate({
    description: `How long to wait, in seconds (0 to ${MAX_WAIT_SECONDS}). Default 0: return what is there now.`,
  }),
})

function regex(source: string | undefined, name: string) {
  if (source === undefined) return undefined
  if (source.length > 300) throw new Error(`${name} is too long (300 characters at most).`)
  try {
    return new RegExp(source)
  } catch (error) {
    throw new Error(`${name} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function lookup(id: string, ctx: Tool.Context) {
  const job = BackgroundShell.get(id, ctx.sessionID)
  if (!job) {
    const known = BackgroundShell.list(ctx.sessionID).map((item) => item.id)
    throw new Error(`No background job ${id} in this session. Known jobs: ${known.length ? known.join(", ") : "none"}.`)
  }
  return job
}

export const MonitorTool = Tool.define(
  "monitor",
  Effect.succeed({
    description:
      "Read the new output of a background job since the last read. With until, wait for a matching line or for the job to end. With timeout_seconds and no until, wait for any new output. Returns the job state and the exit code when it has ended.",
    parameters: MonitorParameters,
    execute: (params: Schema.Schema.Type<typeof MonitorParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const job = lookup(params.id, ctx)
        const until = regex(params.until, "until")
        const match = regex(params.match, "match")
        const seconds = Math.min(Math.max(params.timeout_seconds ?? 0, 0), MAX_WAIT_SECONDS)
        let waited = "returned what was there"
        if (seconds > 0 || until) {
          const end = yield* Effect.promise(() =>
            BackgroundShell.wait(job, {
              until,
              any: !until,
              timeoutMs: seconds * 1000,
              signal: ctx.abort,
            }),
          )
          waited = end === "match" ? (until ? "a line matched" : "new output arrived") : end === "exit" ? "the job ended" : end === "timeout" ? "timed out" : "cancelled"
        }
        const out = BackgroundShell.read(job, { match })
        let text = out.text
        if (text.length > MAX_TEXT) text = "...\n" + text.slice(-MAX_TEXT)
        const head = [
          `job: ${job.id}`,
          `state: ${status(job)}`,
          `wait: ${waited}`,
          ...(out.dropped > 0 ? [`dropped: ${out.dropped} characters of older output were lost`] : []),
        ]
        return {
          title: job.id,
          metadata: { job: job.id, state: job.state, exit: job.exit ?? null },
          output: head.join("\n") + "\n\n" + (text.trim() ? text : "(no new output)"),
        }
      }),
  }),
)

const EmptyParameters = Schema.Struct({})

export const JobListTool = Tool.define(
  "job_list",
  Effect.succeed({
    description: "List the background jobs of this session with their state, age and last output lines.",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, ctx: Tool.Context) =>
      Effect.sync(() => {
        const items = BackgroundShell.list(ctx.sessionID)
        const output = items.length
          ? items
              .map((item) =>
                [
                  `${item.id}  ${status(item)}  ${age(item.ageMs)}  ${item.command}`,
                  ...item.last.map((line) => `    ${line}`),
                ].join("\n"),
              )
              .join("\n")
          : "No background jobs."
        return { title: `${items.length} job${items.length === 1 ? "" : "s"}`, metadata: { count: items.length }, output }
      }),
  }),
)

const StopParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The job id to stop" }),
})

export const JobStopTool = Tool.define(
  "job_stop",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: "Stop a background job. The whole process group gets SIGTERM, and SIGKILL if it does not end.",
      parameters: StopParameters,
      execute: (params: Schema.Schema.Type<typeof StopParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const job = lookup(params.id, ctx)
          const was = job.state
          yield* Effect.promise(() => BackgroundShell.stop(job, "stopped"))
          if (was === "running") {
            const cfg = yield* config.get()
            yield* Effect.promise(() => auditJob("stop", job, cfg))
          }
          const last = BackgroundShell.list(ctx.sessionID).find((item) => item.id === job.id)?.last ?? []
          return {
            title: job.id,
            metadata: { job: job.id, state: job.state },
            output: [`job: ${job.id}`, `state: ${status(job)}`, ...(last.length ? ["", ...last] : [])].join("\n"),
          }
        }),
    }
  }),
)
