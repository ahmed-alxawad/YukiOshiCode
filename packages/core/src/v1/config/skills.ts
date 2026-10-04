export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Learn = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Let the agent save procedures it works out as skills of its own (the skill_save tool), kept in YukiOshi's data folder. Off by default.",
  }),
  max: Schema.optional(PositiveInt).annotate({
    description: "Most learned skills to keep; the least used are retired to the archive beyond this (default 30).",
  }),
  stale_days: Schema.optional(PositiveInt).annotate({
    description: "Retire a learned skill nobody has loaded for this many days (default 90).",
  }),
})

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  learn: Schema.optional(Schema.Union([Schema.Boolean, Learn])).annotate({
    description: "Skills the agent writes itself, with a curator that keeps them few and useful (off by default)",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
