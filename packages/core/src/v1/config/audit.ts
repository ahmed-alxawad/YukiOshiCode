export * as ConfigAuditV1 from "./audit"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Keep a local audit log of tool calls and approvals in the state folder. Off by default; only the global config can turn it on or off.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
