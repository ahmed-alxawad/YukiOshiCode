import { LayerNode } from "@yukioshi/core/effect/layer-node"
import type { ConfigCodeGraphV1 } from "@yukioshi/core/v1/config/code-graph"
import {
  FallbackCodeGraphProvider,
  GraphifyProvider,
  LocalSymbolGraphProvider,
  type CodeGraphProvider,
  type CodeGraphStatus,
  type GraphNeighbor,
  type GraphSymbol,
  type ImportantFile,
} from "@yukioshi/code-graph"
import { Context, Effect, Layer } from "effect"
import type { InstanceContext } from "@/project/instance-context"

export interface Interface {
  readonly status: (input: { ctx: InstanceContext; raw: unknown }) => Effect.Effect<CodeGraphStatus>
  readonly refresh: (input: { ctx: InstanceContext; raw: unknown }) => Effect.Effect<CodeGraphStatus>
  readonly findSymbols: (input: {
    ctx: InstanceContext
    raw: unknown
    query: string
    limit?: number
  }) => Effect.Effect<GraphSymbol[]>
  readonly neighbors: (input: {
    ctx: InstanceContext
    raw: unknown
    path: string
    depth?: number
    limit?: number
  }) => Effect.Effect<GraphNeighbor[]>
  readonly path: (input: {
    ctx: InstanceContext
    raw: unknown
    from: string
    to: string
  }) => Effect.Effect<string[] | undefined>
  readonly importantFiles: (input: {
    ctx: InstanceContext
    raw: unknown
    limit?: number
  }) => Effect.Effect<ImportantFile[]>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/CodeGraph") {}

type Config = ConfigCodeGraphV1.Info

function configOf(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  return raw as Config
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const providers = new Map<string, CodeGraphProvider>()

    function providerFor(ctx: InstanceContext, raw: unknown) {
      const config = configOf(raw)
      const workspaceRoot = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const existing = providers.get(ctx.project.id)
      if (existing) return existing

      const graphify = new GraphifyProvider({
        workspaceRoot,
        ...(config.graphPath ? { graphPath: config.graphPath } : {}),
        ...(config.command ? { command: config.command } : {}),
        ...(config.args ? { args: config.args } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.maxGraphBytes !== undefined ? { maxGraphBytes: config.maxGraphBytes } : {}),
      })
      // The local provider is intentionally conservative here: callers may populate it with an
      // in-memory index, but an absent Graphify artifact must never invent repository facts.
      const provider = new FallbackCodeGraphProvider(graphify, new LocalSymbolGraphProvider())
      providers.set(ctx.project.id, provider)
      return provider
    }

    const status = Effect.fn("CodeGraph.status")(function* (input: { ctx: InstanceContext; raw: unknown }) {
      return yield* Effect.promise(() => providerFor(input.ctx, input.raw).status())
    })
    const refresh = Effect.fn("CodeGraph.refresh")(function* (input: { ctx: InstanceContext; raw: unknown }) {
      return yield* Effect.promise(() => providerFor(input.ctx, input.raw).refresh())
    })
    const findSymbols = Effect.fn("CodeGraph.findSymbols")(function* (input: {
      ctx: InstanceContext
      raw: unknown
      query: string
      limit?: number
    }) {
      return yield* Effect.promise(() => providerFor(input.ctx, input.raw).findSymbols({ text: input.query, limit: input.limit }))
    })
    const neighbors = Effect.fn("CodeGraph.neighbors")(function* (input: {
      ctx: InstanceContext
      raw: unknown
      path: string
      depth?: number
      limit?: number
    }) {
      return yield* Effect.promise(() =>
        providerFor(input.ctx, input.raw).neighbors({ path: input.path, depth: input.depth, limit: input.limit }),
      )
    })
    const path = Effect.fn("CodeGraph.path")(function* (input: {
      ctx: InstanceContext
      raw: unknown
      from: string
      to: string
    }) {
      return yield* Effect.promise(() => providerFor(input.ctx, input.raw).path(input.from, input.to))
    })
    const importantFiles = Effect.fn("CodeGraph.importantFiles")(function* (input: {
      ctx: InstanceContext
      raw: unknown
      limit?: number
    }) {
      return yield* Effect.promise(() => providerFor(input.ctx, input.raw).importantFiles(input.limit ?? 10))
    })

    return Service.of({ status, refresh, findSymbols, neighbors, path, importantFiles })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as CodeGraph from "."
