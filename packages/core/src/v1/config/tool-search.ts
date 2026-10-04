export * as ConfigToolSearchV1 from "./tool-search"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const DEFAULT_THRESHOLD = 20_000
export const DEFAULT_ENABLED = "auto" as const

export const Enabled = Schema.Union([Schema.Boolean, Schema.Literal("auto")])

export const Info = Schema.Struct({
  enabled: Schema.optional(Enabled).annotate({
    description:
      'Control MCP tool search: "auto" turns search on when MCP tool definitions exceed threshold characters, true always enables, false disables. Defaults to "auto".',
  }),
  threshold: Schema.optional(PositiveInt).annotate({
    description:
      'Character count threshold of MCP tool definitions to activate tool search mode in "auto" mode. Defaults to 20000.',
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
