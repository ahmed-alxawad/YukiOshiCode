import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Context, Layer } from "effect"
import { Global } from "@yukioshi/core/global"
import type { InstanceContext } from "@/project/instance-context"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"
import { MemoryStore } from "./store"

export interface Interface {
  readonly root: (ctx: InstanceContext) => Effect.Effect<string>
  readonly remember: (input: { root: string; text: string; key?: string }) => Effect.Effect<{
    key: string
    changed: boolean
  }>
  readonly correct: (input: { root: string; text: string; key?: string }) => Effect.Effect<{
    key: string
    changed: boolean
  }>
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

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service

    const root = Effect.fn("Memory.root")(function* (ctx: InstanceContext) {
      return MemoryPaths.root({ directory: ctx.directory, worktree: ctx.worktree }, global.data)
    })

    const remember = Effect.fn("Memory.remember")(function* (input: { root: string; text: string; key?: string }) {
      return yield* Effect.promise(() => MemoryStore.remember({ ...input, file: "project.md" }))
    })

    const correct = Effect.fn("Memory.correct")(function* (input: { root: string; text: string; key?: string }) {
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

    return Service.of({ root, remember, correct, forget, search, catalog })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node] })

export * as Memory from "."
