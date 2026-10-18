export * as ConfigGitV1 from "./git"

import { Schema } from "effect"

export const Info = Schema.Struct({
  auto_commit: Schema.optional(Schema.Boolean).annotate({
    description:
      "Commit each completed turn's changes (only the files that turn changed). `yukioshi undo` drops only these unpushed commits. Off by default",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>
