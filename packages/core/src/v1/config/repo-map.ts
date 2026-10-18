export * as ConfigRepoMapV1 from "./repo-map"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Add a ranked map of key files and their definitions to the system context. Off by default. Global config only.",
  }),
  tokens: Schema.optional(Schema.Number).annotate({ description: "Token budget for the map (default 1024)" }),
})
export type Info = Schema.Schema.Type<typeof Info>
