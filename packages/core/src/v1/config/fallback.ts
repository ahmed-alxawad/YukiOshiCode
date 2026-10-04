export * as ConfigFallbackV1 from "./fallback"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Keep a turn going when the model's provider fails (rate limit, overload, server error, billing or sign-in failure): switch to the next model in `models`, and rotate between a provider's `apiKeys`. Off by default.",
  }),
  models: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: 'Models to switch to, in order, as "provider/model".',
  }),
  rotate_keys: Schema.optional(Schema.Boolean).annotate({
    description:
      "Rotate between the keys listed in a provider's options.apiKeys when one hits a rate limit, quota, or sign-in error. On by default when fallback is enabled.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
