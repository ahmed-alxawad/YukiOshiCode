import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "../memory"
import { MemorySchema } from "../memory/schema"
import * as Tool from "./tool"

const DESCRIPTION =
  "Recall durable project memory saved earlier with memory_save: general project facts, environment notes, and corrections. Use 'search' with a topic query, or 'catalog' to list everything stored (optionally filtered). Memory is scoped to this project and persists across sessions."

export const Parameters = Schema.Struct({
  mode: Schema.Literals(["search", "catalog"]).annotate({
    description: "'search' a topic query against stored memory, or 'catalog' to list what's stored",
  }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))).annotate({
    description: "Topic query for search mode; optional substring filter for catalog mode",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results for search mode (default 5, max 20)",
  }),
})

function sourceHeading(file: MemorySchema.Source) {
  if (file === "corrections.md") return "Corrections"
  if (file === "environment.md") return "Environment"
  return "Project"
}

export const MemoryRecallTool = Tool.define(
  "memory_recall",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = yield* memory.root(instance)

          yield* ctx.ask({
            permission: "memory_recall",
            patterns: [params.mode],
            always: ["*"],
            metadata: { mode: params.mode, ...(params.query ? { query: params.query } : {}) },
          })

          if (params.mode === "catalog") {
            const result = yield* memory.catalog({ root, query: params.query })
            const sources = Object.keys(result.bySource)
            if (result.count === 0) {
              return {
                title: "Memory catalog: empty",
                output: "No stored memory entries matched.",
                metadata: { sources },
              }
            }
            const lines: string[] = []
            for (const [file, entries] of Object.entries(result.bySource)) {
              lines.push(`## ${sourceHeading(file as MemorySchema.Source)}`)
              for (const entry of entries) lines.push(`- ${entry.key} :: ${entry.text}`)
            }
            return {
              title: `Memory catalog: ${result.count} entr${result.count === 1 ? "y" : "ies"}`,
              output: lines.join("\n"),
              metadata: { sources },
            }
          }

          const query = params.query?.trim() ?? ""
          if (!query) {
            return {
              title: "Memory search: no query",
              output: "Provide a topic query for search mode.",
              metadata: { sources: [] as string[] },
            }
          }
          const limit = Math.max(1, Math.min(params.limit ?? 5, 20))
          const hits = yield* memory.search({ root, query, limit })
          if (hits.length === 0) {
            return {
              title: "Memory search: no results",
              output: `No memory matched "${query}".`,
              metadata: { sources: [] as string[] },
            }
          }
          const output = hits.map((hit) => `[${sourceHeading(hit.source)}] ${hit.key} :: ${hit.text}`).join("\n")
          return {
            title: `Memory search: ${hits.length} hit${hits.length === 1 ? "" : "s"}`,
            output,
            metadata: { sources: [...new Set(hits.map((hit) => hit.source))] },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
