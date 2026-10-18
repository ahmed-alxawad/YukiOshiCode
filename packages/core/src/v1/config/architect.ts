export * as ConfigArchitectV1 from "./architect"

import { Schema } from "effect"

const ModelString = Schema.String.check(
  Schema.isPattern(/^[^/\s]+\/\S+$/, { message: 'must look like "provider/model", for example "anthropic/claude-sonnet-4-5"' }),
)

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Architect/editor mode: a read-only planner model writes an edit plan, then an editor subagent with its own model applies it. Off by default.",
  }),
  planner_model: Schema.optional(ModelString).annotate({
    description: "Model of the planner (provider/model). Defaults to the session model.",
  }),
  editor_model: Schema.optional(ModelString).annotate({
    description: "Model of the editor subagent (provider/model). Defaults to the planner's model.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
