import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigShellV1.Info")({
  kill_on_exit: Schema.optional(Schema.Boolean).annotate({
    description: "Terminate shell commands when YukiOshi exits (off by default)",
  }),
}) {}

