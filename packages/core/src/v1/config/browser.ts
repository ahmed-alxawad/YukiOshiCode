export * as ConfigBrowserV1 from "./browser"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable browser automation using the Playwright MCP server. Off by default.",
  }),
  headless: Schema.optional(Schema.Boolean).annotate({
    description: "Run browser in headless mode. Defaults to true.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
