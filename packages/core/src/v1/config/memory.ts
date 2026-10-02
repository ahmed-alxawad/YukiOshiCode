export * as ConfigMemoryV1 from "./memory"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the memory_recall/memory_save tools, letting the agent explicitly save and recall durable project facts, environment notes, and corrections across sessions. Off by default.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
