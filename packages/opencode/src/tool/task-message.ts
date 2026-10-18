import * as Tool from "./tool"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Config } from "@/config/config"
import { Effect, Schema, Scope } from "effect"
import { Database } from "@yukioshi/core/database/database"
import type { TaskPromptOps } from "./task"
import { backgroundSubagents, markSubagentReport } from "./subagents"
import { RuntimeFlags } from "@/effect/runtime-flags"

const id = "task_message"

const DESCRIPTION = [
  "Send a follow-up message to a subagent you started earlier, running or finished, and resume it.",
  "Identify it by task_id (the id in the task result), or by the agent name when only one subagent of that name exists in this session.",
  "The reply is delivered to you automatically when the subagent finishes; do not poll for it.",
].join(" ")

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task_id of the subagent, or its agent name when unique in this session" }),
  message: Schema.String.annotate({ description: "The follow-up message for the subagent" }),
})

export const TaskMessageTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskMessageTool.execute")(function* (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      if (!backgroundSubagents(flags, cfg)) {
        return yield* Effect.fail(
          new Error('task_message needs background subagents. Turn them on with "subagents": { "background": true }.'),
        )
      }
      let current = yield* sessions.get(ctx.sessionID)
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(`Subagents cannot message other subagents here (subagent_depth is ${cfg.subagent_depth ?? 1}).`),
        )
      }

      const children = yield* sessions.children(ctx.sessionID)
      const matches = children.filter((child) => child.id === params.task_id)
      const byName = matches.length ? matches : children.filter((child) => child.agent === params.task_id)
      if (byName.length === 0) return yield* Effect.fail(new Error(`Unknown task_id: ${params.task_id}`))
      if (byName.length > 1) {
        return yield* Effect.fail(
          new Error(`More than one subagent is named ${params.task_id}; pass one of these task_ids: ${byName.map((c) => c.id).join(", ")}`),
        )
      }
      const target = byName[0]!
      const agentName = target.agent ?? "general"

      yield* ctx.ask({ permission: id, patterns: [agentName], always: ["*"], metadata: { task_id: target.id } })

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const model = { modelID: msg.info.modelID, providerID: msg.info.providerID }
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskMessageTool requires promptOps in ctx.extra"))

      const metadata = { parentSessionId: ctx.sessionID, sessionId: target.id, model, background: true, jobId: target.id }
      yield* ctx.metadata({ title: `Message to ${agentName}`, metadata })

      const runMessage = Effect.fn("TaskMessageTool.runMessage")(function* () {
        const parts = yield* ops.resolvePromptParts(params.message, { restrictToProject: true })
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: SessionID.make(target.id),
          model,
          variant,
          agent: agentName,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const error = result.info.error
          return yield* Effect.fail(
            new Error("message" in error.data && typeof error.data.message === "string" ? error.data.message : error.name),
          )
        }
        return markSubagentReport(result.parts.findLast((item) => item.type === "text")?.text ?? "")
      })

      const inject = (state: "completed" | "error", text: string) =>
        Effect.gen(function* () {
          const currentParent = yield* sessions.get(ctx.sessionID)
          yield* ops
            .prompt({
              sessionID: ctx.sessionID,
              agent: currentParent.agent ?? ctx.agent,
              variant,
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text: [
                    `<task id="${target.id}" state="${state}">`,
                    `<${state === "error" ? "task_error" : "task_result"}>`,
                    text,
                    `</${state === "error" ? "task_error" : "task_result"}>`,
                    "</task>",
                  ].join("\n"),
                },
              ],
            })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

      const notify = (jobID: string) =>
        background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )

      const delivered = (summary: string) => ({
        title: `Message to ${agentName}`,
        metadata,
        output: `<task id="${target.id}" state="running">\n<summary>${summary}</summary>\nThe reply is delivered to you automatically when the subagent finishes. Do not poll.\n</task>`,
      })

      // A running subagent gets the message queued onto its job; a finished one is resumed as a new job.
      if (yield* background.extend({ id: target.id, run: runMessage() })) return delivered("Message sent to the running subagent")
      const info = yield* background.start({
        id: target.id,
        type: "task",
        title: target.title,
        metadata,
        run: runMessage().pipe(Effect.onInterrupt(() => ops.cancel(target.id as SessionID))),
      })
      yield* notify(info.id)
      return delivered("Subagent resumed with your message")
    })

    return () =>
      Effect.succeed({
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
      })
  }),
)
