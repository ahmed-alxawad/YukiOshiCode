export * as ConfigCodeGraphV1 from "./code-graph"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the read-only code_graph tool. Off by default.",
  }),
  graphPath: Schema.optional(Schema.String).annotate({
    description: "Workspace-relative Graphify graph file path. Defaults to graphify-out/graph.json.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "Optional Graphify executable used when refreshing the graph.",
  }),
  args: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Arguments passed to the Graphify executable when refreshing.",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description: "Maximum time allowed for a Graphify refresh.",
  }),
  maxGraphBytes: Schema.optional(Schema.Number).annotate({
    description: "Maximum Graphify graph file size accepted by the loader.",
  }),
}).annotate({
  identifier: "CodeGraphConfig",
  description: "Repository-structure signals from Graphify with a local fallback.",
})

export type Info = Schema.Schema.Type<typeof Info>
