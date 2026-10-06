export * as ConfigRedactV1 from "./redact"

import { Schema } from "effect"

export const DEFAULT_ENABLED = true

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Mask unmistakable secrets before sending to model providers (defaults to true).",
  }),
  patterns: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Extra regex patterns to redact.",
  }),
  allow: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Specific secret values to never mask.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
