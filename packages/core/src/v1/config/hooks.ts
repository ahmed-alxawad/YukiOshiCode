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
}).annotate({ identifier: "HookCommand" })
export type HookCommand = Schema.Schema.Type<typeof HookCommand>

export const Info = Schema.Struct({
  preToolUse: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "Before a tool call, before the permission check. Exit code 2 (or {\"decision\":\"block\"}) blocks it.",
  }),
  postToolUse: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "After a tool call ran. The call already happened; a block is sent to the model as feedback.",
  }),
  userPromptSubmit: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "Before your message is sent. Stdout is added to the conversation as context.",
  }),
  sessionStart: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "When a new session starts. Stdout is added to the conversation as context.",
  }),
  stop: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "When a task completes.",
  }),
  subagentStop: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "When a subagent finishes its task.",
  }),
  preCompact: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "Before a long conversation is compacted (summarised), automatically or on request.",
  }),
  notification: Schema.optional(Schema.Array(HookCommand)).annotate({
    description: "When the agent is waiting for your permission approval.",
  }),
}).annotate({
  identifier: "HooksConfig",
  description:
    "Shell-command hooks run at fixed points in the agent's work (Claude Code compatible conventions). Each event takes an array of commands, run one after another.",
})
export type Info = Schema.Schema.Type<typeof Info>
