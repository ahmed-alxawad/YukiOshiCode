import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Indexing } from "../indexing"
import * as Tool from "./tool"

const DESCRIPTION =
  "Search the codebase by meaning, not just text (semantic/embedding-based search). Use this for conceptual queries like 'where do we validate user input' or 'rate limiting logic' that grep/glob would miss because the exact words don't appear in the code. Falls back to indicating indexing is still in progress if the project hasn't finished indexing yet - grep/glob still work meanwhile."

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Natural-language description of the code you're looking for" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum results to return (default 10, max 50)" }),
})

function formatResult(result: {
  score: number
  payload?: { filePath: string; startLine: number; endLine: number; codeChunk: string } | null
}) {
  if (!result.payload) return undefined
  const { filePath, startLine, endLine, codeChunk } = result.payload
  return [
    `${filePath}:${startLine}-${endLine} (score ${result.score.toFixed(3)})`,
    "```",
    codeChunk.trim(),
    "```",
  ].join("\n")
}

export const CodeSearchTool = Tool.define(
  "code_search",
  Effect.gen(function* () {
    const indexing = yield* Indexing.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cfg = yield* config.get()

          yield* ctx.ask({
            permission: "code_search",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query },
          })

          const status = yield* indexing.status({ ctx: instance, raw: cfg.indexing })
          if (status.systemStatus === "Error") {
            return {
              title: "Code search: indexing error",
              output: `Indexing is in an error state: ${status.message}`,
              metadata: { count: 0 },
            }
          }
          // Standby covers both "disabled" and "enabled but not configured (e.g. no API key)" -
          // the manager hasn't built its search service yet in either case, so searching would throw.
          if (status.systemStatus === "Standby") {
            return {
              title: "Code search: not available",
              output: `Codebase indexing isn't active yet (${status.message}). grep/glob still work in the meantime.`,
              metadata: { count: 0 },
            }
          }

          const limit = Math.max(1, Math.min(params.limit ?? 10, 50))
          const hits = yield* indexing.search({ ctx: instance, raw: cfg.indexing, query: params.query })
          const top = hits.slice(0, limit)
          const blocks = top.map(formatResult).filter((block): block is string => block !== undefined)

          const note =
            status.systemStatus === "Indexing"
              ? "\n\n(Indexing is still in progress - results may be incomplete. grep/glob cover the rest of the codebase in the meantime.)"
              : ""

          if (blocks.length === 0) {
            return {
              title: "Code search: no results",
              output: `No semantic matches for "${params.query}".${note}`,
              metadata: { count: 0 },
            }
          }

          return {
            title: `Code search: ${blocks.length} result${blocks.length === 1 ? "" : "s"}`,
            output: blocks.join("\n\n") + note,
            metadata: { count: blocks.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
