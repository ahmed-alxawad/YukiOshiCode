export * as ConfigWebFetchV1 from "./webfetch"

import { Schema } from "effect"

export const Info = Schema.Struct({
  allow_private: Schema.optional(Schema.Boolean).annotate({
    description:
      "Permit webfetch access to private or local network addresses after a mandatory interactive warning. Global config only.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
