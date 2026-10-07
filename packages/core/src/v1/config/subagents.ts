export * as ConfigSubagentsV1 from "./subagents"

import { Schema } from "effect"

export const Info = Schema.Struct({
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Let the agent start a subagent in the background (task with background: true) and keep working while it runs. Off by default.",
  }),
  parallel: Schema.optional(Schema.Boolean).annotate({
    description:
      "Give the agent the task_parallel tool, which runs up to 8 subagents at once, each optionally in its own git worktree. Off by default.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
