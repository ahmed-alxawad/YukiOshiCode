import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "../memory"
import { MemoryStore } from "../memory/store"
import { Config } from "@/config/config"
import * as Tool from "./tool"

const DESCRIPTION =
  "Save or remove durable project memory that should persist across sessions. 'remember' saves a general project fact; 'correct' saves something the user corrected you on (checked first on recall); 'forget' removes an entry by key or a substring match. Keep saved text concise and genuinely durable - not something specific to this one task."

export const Parameters = Schema.Struct({
  action: Schema.Literals(["remember", "correct", "forget"]).annotate({
    description: "Memory write action to perform",
  }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(MemoryStore.ENTRY_MAX))).annotate({
    description: `Memory text to save for remember/correct: a sentence or two, at most ${MemoryStore.ENTRY_MAX} characters.`,
  }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))).annotate({
    description: "Key or substring to match for forget",
  }),
  key: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Optional stable key for remember/correct; auto-generated from the text if omitted",
  }),
})

export const MemorySaveTool = Tool.define(
  "memory_save",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = yield* memory.root(instance)

          if (params.action === "forget") {
            const query = (params.query ?? params.text ?? "").trim()
            if (!query) {
              return {
                title: "Memory forget: no query",
                output: "Provide a key or substring to forget.",
                metadata: { sources: [] as string[] },
              }
            }
            yield* ctx.ask({
              permission: "memory_save",
              patterns: ["forget"],
              always: [],
              metadata: { action: "forget", query },
            })
            const result = yield* memory.forget({ root, query })
            return {
              title: `Memory forget: ${result.removed} removed`,
              output: `removed=${result.removed}\nfiles=${result.files.join(",") || "none"}`,
              metadata: { sources: result.files },
            }
          }

          const text = (params.text ?? "").trim()
          if (!text) {
            return {
              title: `Memory ${params.action}: no text`,
              output: `Provide text to ${params.action}.`,
              metadata: { sources: [] as string[] },
            }
          }
          yield* ctx.ask({
            permission: "memory_save",
            patterns: [params.action],
            always: [],
            metadata: { action: params.action, ...(params.key ? { key: params.key } : {}), text },
          })
          const maxChars = (yield* config.get()).memory?.max_chars
          const result =
            params.action === "correct"
              ? yield* memory.correct({ root, text, key: params.key, maxChars })
              : yield* memory.remember({ root, text, key: params.key, maxChars })
          if (result.full) {
            // Memory is shown in every request, so it stays within its limit: the agent consolidates first.
            const { bySource } = yield* memory.catalog({ root })
            const entries = Object.values(bySource).flatMap((list) => list ?? [])
            return {
              title: "Memory full",
              output: [
                `Not saved: memory holds ${result.full.used} of ${result.full.max} characters and this entry does not fit.`,
                "Make room first: forget entries that are no longer true, or save a shorter entry under an existing key to merge several into one. Current entries:",
                ...entries.map((entry) => `- ${entry.key} :: ${entry.text}`),
              ].join("\n"),
              metadata: { sources: [] as string[] },
            }
          }
          const source = params.action === "correct" ? "corrections.md" : "project.md"
          return {
            title: result.changed
              ? `Memory ${params.action === "correct" ? "correction" : ""} saved: ${result.key}`.replace(/\s+/g, " ")
              : "Memory unchanged",
            output: `action=${params.action}\nkey=${result.key}\nchanged=${result.changed}`,
            metadata: { sources: [source] },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
