export * as ConfigGoalV1 from "./goal"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Allow /goal: keep working on a standing objective, checked by a small model after every turn, until it is done. On by default; nothing happens until you set a goal.",
  }),
  max_rounds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "How many automatic continuation rounds a goal may run before it pauses for you. Default 20.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
