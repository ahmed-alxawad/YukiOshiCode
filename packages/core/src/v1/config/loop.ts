export * as ConfigLoopV1 from "./loop"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Turn on /loop, which runs a prompt or slash command again on an interval. Off by default.",
  }),
  max_runs: Schema.optional(PositiveInt).annotate({
    description: "Most runs of one loop before it stops by itself (default 50).",
  }),
  min_interval: Schema.optional(PositiveInt).annotate({
    description: "Shortest allowed interval between runs, in seconds (default 60).",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
