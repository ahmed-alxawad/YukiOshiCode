export * as ConfigMemoryV1 from "./memory"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the memory_recall/memory_save tools, letting the agent explicitly save and recall durable project facts, environment notes, and corrections across sessions. Off by default.",
  }),
  max_chars: Schema.optional(PositiveInt).annotate({
    description:
      "Most characters a project's memory may hold, across all its entries (default 4000). Memory is shown to the agent at the start of every request, so it stays small; when it is full the agent must merge or forget entries before saving more.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
