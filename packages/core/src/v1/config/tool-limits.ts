export * as ConfigToolLimitsV1 from "./tool-limits"

import { Schema } from "effect"
import { NonNegativeInt } from "../../schema"

const Milliseconds = NonNegativeInt

export const Info = Schema.Struct({
  repeat_nudge: Schema.optional(Schema.Boolean).annotate({
    description:
      "Add a note to a tool result when the model repeats the same call with the same input and gets the same result (from the third time in a turn). On by default.",
  }),
  timeout: Schema.optional(Schema.Union([Milliseconds, Schema.Record(Schema.String, Milliseconds)])).annotate({
    description:
      'Time limit for tool calls in milliseconds: one number for all tools, or per tool ({ "*": 120000, "webfetch": 30000 }). 0 turns a limit off. A catch-all limit skips bash (which has its own), task, task_parallel, question, and plan_exit. No limit by default.',
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
