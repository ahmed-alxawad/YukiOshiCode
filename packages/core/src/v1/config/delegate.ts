export * as ConfigDelegateV1 from "./delegate"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes in ms

export const Agent = Schema.Struct({
  command: Schema.Array(Schema.String).annotate({
    description: "Command and arguments to spawn the external ACP agent process.",
  }),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional environment variables for the agent process.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in milliseconds for the delegated session. Defaults to 30 minutes (1,800,000 ms).",
  }),
  handshakeTimeout: Schema.optional(Schema.Unknown).annotate({
    description:
      "Milliseconds the agent may take to answer each ACP handshake step (initialize and new session). Defaults to 60 seconds (60,000 ms). Raise it for slow first starts such as a first npx download. Values that are not a positive finite number are ignored.",
  }),
})
export type Agent = Schema.Schema.Type<typeof Agent>

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable delegating tasks to external coding agents over ACP. Defaults to false.",
  }),
  agents: Schema.optional(Schema.Record(Schema.String, Agent)).annotate({
    description: "Configured external agents accessible by the delegate tool.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
