import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Context, Layer } from "effect"
import { Global } from "@yukioshi/core/global"
import type { InstanceContext } from "@/project/instance-context"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"
import { MemoryStore } from "./store"

export interface Interface {
  readonly root: (ctx: InstanceContext) => Effect.Effect<string>
  readonly remember: (input: SaveInput) => Effect.Effect<MemoryStore.Saved>
  readonly correct: (input: SaveInput) => Effect.Effect<MemoryStore.Saved>
  /** The project's memory for the system prompt, or undefined when there is none. */
  readonly prompt: (input: { root: string; maxChars?: number }) => Effect.Effect<string | undefined>
  readonly forget: (input: {
    root: string
    query: string
  }) => Effect.Effect<{ removed: number; files: MemorySchema.Source[] }>
  readonly search: (input: {
    root: string
    query: string
    limit: number
  }) => Effect.Effect<MemoryStore.SearchHit[]>
  readonly catalog: (input: {
    root: string
    query?: string
  }) => Effect.Effect<Awaited<ReturnType<typeof MemoryStore.catalog>>>
}

type SaveInput = { root: string; text: string; key?: string; maxChars?: number }

// Corrections first: they are what the user told the agent to stop doing.
const PROMPT_ORDER = ["corrections.md", "environment.md", "project.md"] as const
const PROMPT_TITLE = { "corrections.md": "Corrections", "environment.md": "Environment", "project.md": "Facts" }

/** Formats memory entries for the system prompt, cut at `maxChars` if files were edited past the limit. */
export function promptText(entries: Partial<Record<MemorySchema.Source, { key: string; text: string }[]>>, maxChars: number) {
  const lines: string[] = []
  let size = 0
  let cut = false
  for (const source of PROMPT_ORDER) {
    const list = entries[source] ?? []
    if (list.length === 0) continue
    lines.push(`## ${PROMPT_TITLE[source]}`)
    for (const entry of list) {
      size += entry.key.length + entry.text.length
      if (size > maxChars) {
        cut = true
        break
      }
      lines.push(`- ${entry.key} :: ${entry.text}`)
    }
    if (cut) break
  }
  if (lines.every((line) => line.startsWith("## "))) return undefined
  return [
    "<project_memory>",
    "What you saved about this project in earlier sessions with memory_save. Follow the corrections.",
    ...lines,
    ...(cut ? ["(Memory is over its size limit and was cut here; merge or forget entries.)"] : []),
    "</project_memory>",
  ].join("\n")
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service

    const root = Effect.fn("Memory.root")(function* (ctx: InstanceContext) {
      return MemoryPaths.root({ directory: ctx.directory, worktree: ctx.worktree }, global.data)
    })

    const remember = Effect.fn("Memory.remember")(function* (input: SaveInput) {
      return yield* Effect.promise(() => MemoryStore.remember({ ...input, file: "project.md" }))
    })

    const correct = Effect.fn("Memory.correct")(function* (input: SaveInput) {
      return yield* Effect.promise(() => MemoryStore.remember({ ...input, file: "corrections.md" }))
    })

    const forget = Effect.fn("Memory.forget")(function* (input: { root: string; query: string }) {
      return yield* Effect.promise(() => MemoryStore.forget(input))
    })

    const search = Effect.fn("Memory.search")(function* (input: { root: string; query: string; limit: number }) {
      return yield* Effect.promise(() => MemoryStore.search(input))
    })

    const catalog = Effect.fn("Memory.catalog")(function* (input: { root: string; query?: string }) {
      return yield* Effect.promise(() => MemoryStore.catalog(input))
    })

    const prompt = Effect.fn("Memory.prompt")(function* (input: { root: string; maxChars?: number }) {
      const { bySource } = yield* Effect.promise(() => MemoryStore.catalog({ root: input.root }))
      return promptText(bySource, input.maxChars ?? MemoryStore.DEFAULT_MAX_CHARS)
    })

    return Service.of({ root, remember, correct, forget, search, catalog, prompt })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node] })

export * as Memory from "."
