export * as ConfigHooksV1 from "./hooks"
import { Schema } from "effect"

export const HookCommand = Schema.Struct({
  matcher: Schema.optional(Schema.String).annotate({
    description: "Regex matched against the whole tool/permission id. Omit, or use '*', to match every tool.",
  }),
  command: Schema.String.annotate({
    description: "Shell command line. Runs with $SHELL (or /bin/sh) on macOS/Linux, cmd.exe on Windows.",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Default 60000." }),
  failClosed: Schema.optional(Schema.Boolean).annotate({
    description:
      "preToolUse/userPromptSubmit only: block the call when this hook cannot run, times out or fails, instead of warning and continuing. Default false.",
  }),
}).annotate({ identifier: "HookCommand" })
export type HookCommand = Schema.Schema.Type<typeof HookCommand>

export const HookHttp = Schema.Struct({
  type: Schema.Literal("http").annotate({ description: "An HTTP hook: POSTs the hook's JSON to `url`." }),
  url: Schema.String.pipe(
    Schema.refine((value): value is string => {
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
      } catch {
        return false
      }
    }),
  ).annotate({ description: "HTTP hook endpoint. Must use http:// or https://." }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send. $NAME or ${NAME} is replaced only for variables listed in allowedEnvVars.",
  }),
  allowedEnvVars: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Environment variables that headers may use as $NAME or ${NAME}. Others become empty.",
  }),
  allowPrivateAddress: Schema.optional(Schema.Boolean).annotate({
    description:
      "Allow a private, loopback or link-local destination. Honoured only for hooks in your global config.",
  }),
  matcher: Schema.optional(Schema.String).annotate({
    description: "Regex matched against the whole tool/permission id. Omit, or use '*', to match every tool.",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Default 5000." }),
  failClosed: Schema.optional(Schema.Boolean).annotate({
    description:
      "preToolUse/userPromptSubmit only: block the call when this hook cannot run, times out or fails, instead of warning and continuing. Default false.",
  }),
}).annotate({ identifier: "HookHttp" })
export type HookHttp = Schema.Schema.Type<typeof HookHttp>

// An entry with `type: "http"` is an HTTP hook, never a command hook (see the config test).
export const Hook = Schema.Union([HookHttp, HookCommand])
export type Hook = Schema.Schema.Type<typeof Hook>

export const Info = Schema.Struct({
  preToolUse: Schema.optional(Schema.Array(Hook)).annotate({
    description: "Before a tool call, before the permission check. Exit code 2 (or {\"decision\":\"block\"}) blocks it.",
  }),
  postToolUse: Schema.optional(Schema.Array(Hook)).annotate({
    description: "After a tool call ran. The call already happened; a block is sent to the model as feedback.",
  }),
  userPromptSubmit: Schema.optional(Schema.Array(Hook)).annotate({
    description: "Before your message is sent. Stdout is added to the conversation as context.",
  }),
  sessionStart: Schema.optional(Schema.Array(Hook)).annotate({
    description: "When a new session starts. Stdout is added to the conversation as context.",
  }),
  stop: Schema.optional(Schema.Array(Hook)).annotate({
    description: "When a task completes.",
  }),
  subagentStart: Schema.optional(Schema.Array(Hook)).annotate({
    description: "When a subagent session starts (foreground, background or parallel).",
  }),
  subagentStop: Schema.optional(Schema.Array(Hook)).annotate({
    description: "When a subagent finishes its task.",
  }),
  preCompact: Schema.optional(Schema.Array(Hook)).annotate({
    description: "Before a long conversation is compacted (summarised), automatically or on request.",
  }),
  notification: Schema.optional(Schema.Array(Hook)).annotate({
    description: "When the agent is waiting for your permission approval.",
  }),
}).annotate({
  identifier: "HooksConfig",
  description:
    "Hooks run at fixed points in the agent's work (Claude Code compatible conventions). Each event takes an array of hooks, run one after another.",
})
export type Info = Schema.Schema.Type<typeof Info>
