export * as ConfigSandboxV1 from "./sandbox"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Run the bash tool inside an OS-level sandbox (bubblewrap on Linux, sandbox-exec on macOS). Off by default.",
  }),
  network: Schema.optional(Schema.Literals(["allow", "deny"])).annotate({
    description: "Network policy for sandboxed commands. Default: allow.",
  }),
  writablePaths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Extra paths (beyond the workspace and YukiOshi's own data directories) the sandbox allows writing to.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
