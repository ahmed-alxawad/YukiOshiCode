export * as ConfigLearningV1 from "./learning"

import { Schema } from "effect"

export const Info = Schema.Struct({
  nudges: Schema.optional(Schema.Boolean).annotate({
    description:
      "After a long or error-fixing turn, remind the agent that it may save lessons with memory_save / skill_save. Off by default. Global config only.",
  }),
  min_tool_calls: Schema.optional(Schema.Number).annotate({
    description: "Tool calls in one turn that count as a long turn (default 8)",
  }),
  every_turns: Schema.optional(Schema.Number).annotate({
    description: "At most one nudge per this many turns (default 20)",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
