export * as ConfigBackgroundShellV1 from "./background-shell"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Let the agent start shell commands in the background (shell with background: true) and follow them with the monitor, job_list and job_stop tools. Off by default.",
  }),
  max_jobs: Schema.optional(PositiveInt).annotate({
    description: "Most background jobs that may run at once in one session. Defaults to 4.",
  }),
  max_minutes: Schema.optional(PositiveInt).annotate({
    description: "A background job is killed after this many minutes. Defaults to 30.",
  }),
  buffer_kb: Schema.optional(PositiveInt).annotate({
    description: "Output kept per job, in KB. The oldest output is dropped first. Defaults to 1024.",
  }),
  run_wait_seconds: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "How long yukioshi run waits for running background jobs before it kills them. Defaults to 60. Use 0 to kill them at once.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
