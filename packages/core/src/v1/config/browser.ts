export * as ConfigBrowserV1 from "./browser"

import { Schema } from "effect"

export const Engine = Schema.Literals(["chrome", "chromium", "firefox", "webkit", "msedge"])
export type Engine = Schema.Schema.Type<typeof Engine>

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable browser automation using the Playwright MCP server. Off by default.",
  }),
  headless: Schema.optional(Schema.Boolean).annotate({
    description: "Run browser in headless mode. Defaults to true.",
  }),
  engine: Schema.optional(Engine).annotate({
    description: "Browser engine to use (chrome, chromium, firefox, webkit, msedge). Defaults to chrome.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>

