import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { CodeGraph } from "../code-graph"
import * as Tool from "./tool"

const DESCRIPTION =
  "Inspect repository structure using code-graph signals: symbols, neighboring files, paths, and important files. These answers are retrieval hints only, not ground truth; always re-read the relevant files before editing and use grep/glob/LSP to verify details."

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["status", "refresh", "find_symbols", "neighbors", "path", "important_files"]),
  query: Schema.optional(Schema.String).annotate({ description: "Symbol name or text to search for" }),
  path: Schema.optional(Schema.String).annotate({ description: "Workspace-relative file path" }),
  from: Schema.optional(Schema.String).annotate({ description: "Workspace-relative starting file path" }),
  to: Schema.optional(Schema.String).annotate({ description: "Workspace-relative destination file path" }),
  depth: Schema.optional(Schema.Number).annotate({ description: "Neighbor traversal depth (default 1)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of results (default 10)" }),
})

function output(value: unknown) {
  return JSON.stringify(value, null, 2)
}

export const CodeGraphTool = Tool.define(
  "code_graph",
  Effect.gen(function* () {
    const graph = yield* CodeGraph.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cfg = yield* config.get()
          const initialStatus = yield* graph.status({ ctx: instance, raw: cfg.code_graph })
          yield* ctx.ask({
            permission: "code_graph",
            patterns: [params.operation],
            always: ["*"],
            metadata: { operation: params.operation },
          })

          const raw = cfg.code_graph
          let result: unknown
          switch (params.operation) {
            case "status":
              result = yield* graph.status({ ctx: instance, raw })
              break
            case "refresh":
              result = yield* graph.refresh({ ctx: instance, raw })
              break
            case "find_symbols":
              if (!params.query)
                return {
                  title: "Code graph: query required",
                  output: "query is required",
                  metadata: { provider: initialStatus.provider, available: initialStatus.available },
                }
              result = yield* graph.findSymbols({ ctx: instance, raw, query: params.query, limit: params.limit })
              break
            case "neighbors":
              if (!params.path)
                return {
                  title: "Code graph: path required",
                  output: "path is required",
                  metadata: { provider: initialStatus.provider, available: initialStatus.available },
                }
              result = yield* graph.neighbors({ ctx: instance, raw, path: params.path, depth: params.depth, limit: params.limit })
              break
            case "path":
              if (!params.from || !params.to)
                return {
                  title: "Code graph: from and to required",
                  output: "from and to are required",
                  metadata: { provider: initialStatus.provider, available: initialStatus.available },
                }
              result = yield* graph.path({ ctx: instance, raw, from: params.from, to: params.to })
              break
            case "important_files":
              result = yield* graph.importantFiles({ ctx: instance, raw, limit: params.limit })
              break
          }

          const status = yield* graph.status({ ctx: instance, raw })
          return {
            title: `Code graph: ${params.operation}`,
            output: `${output(result)}\n\nGraph answers are signals only. Re-read files before editing; verify with grep, glob, or LSP.\n\nStatus: ${status.message}`,
            metadata: { provider: status.provider, available: status.available },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
