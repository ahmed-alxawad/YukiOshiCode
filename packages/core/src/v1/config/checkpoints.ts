export * as ConfigCheckpointsV1 from "./checkpoints"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Create durable git checkpoints after changed turns" }),
})

export type Info = Schema.Schema.Type<typeof Info>
