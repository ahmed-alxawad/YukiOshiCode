export * as ConfigTriggersV1 from "./triggers"

import { Schema } from "effect"

export const TriggerMode = Schema.Literals(["review", "plan"])
export type TriggerMode = Schema.Schema.Type<typeof TriggerMode>

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the authenticated POST /trigger endpoint on yukioshi serve. Off by default; only global config.",
  }),
  token_env: Schema.optional(Schema.String).annotate({
    description: "Environment variable name containing the bearer token (must be at least 32 characters long).",
  }),
  directories: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Allowed directories where triggers can start runs (absolute paths).",
  }),
  mode: Schema.optional(TriggerMode).annotate({
    description: "Run mode for triggers ('review' or 'plan'; defaults to 'review'). Never 'auto-all'.",
  }),
}).annotate({ identifier: "ConfigTriggersV1" })
export type Info = Schema.Schema.Type<typeof Info>
