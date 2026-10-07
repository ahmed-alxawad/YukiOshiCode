export * as ConfigWebSearchV1 from "./web-search"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Give the agent the websearch tool. Off by default. Search queries are sent to the chosen service.",
  }),
  provider: Schema.optional(Schema.Literals(["exa", "parallel"])).annotate({
    description:
      "Search service: exa (default) or parallel. Both work without a key; EXA_API_KEY or PARALLEL_API_KEY raises the limits.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
