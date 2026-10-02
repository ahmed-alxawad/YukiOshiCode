import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Global } from "@yukioshi/core/global"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { CodeIndexManager } from "@yukioshi/indexing/engine"
import type { VectorStoreSearchResult } from "@yukioshi/indexing/engine"
import { IndexingConfig, toIndexingConfigInput } from "@yukioshi/indexing/config"
import type { InstanceContext } from "@/project/instance-context"

export class ConfigError extends Error {
  readonly _tag = "Indexing.ConfigError"
}

export interface Status {
  readonly systemStatus: "Standby" | "Indexing" | "Indexed" | "Error"
  readonly message: string
}

export interface Interface {
  readonly search: (input: {
    ctx: InstanceContext
    raw: unknown
    query: string
  }) => Effect.Effect<VectorStoreSearchResult[], ConfigError>
  readonly status: (input: { ctx: InstanceContext; raw: unknown }) => Effect.Effect<Status, ConfigError>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Indexing") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const managers = new Map<string, CodeIndexManager>()

    function managerFor(ctx: InstanceContext): CodeIndexManager {
      const key = ctx.project.id
      const existing = managers.get(key)
      if (existing) return existing
      // Non-git projects set worktree to "/" (see project/instance-context.ts) - don't index "/".
      const workspacePath = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const cacheDirectory = path.join(global.data, "indexing", key)
      const manager = new CodeIndexManager(workspacePath, cacheDirectory)
      managers.set(key, manager)
      return manager
    }

    // Validates with @yukioshi/indexing's own (much larger, already-tested) zod schema -
    // YukiOshi's own config field is a passthrough record, see core/src/v1/config/indexing.ts.
    const ensure = Effect.fn("Indexing.ensure")(function* (ctx: InstanceContext, raw: unknown) {
      const parsed = IndexingConfig.safeParse(raw ?? {})
      if (!parsed.success) {
        return yield* Effect.fail(new ConfigError(`Invalid indexing config: ${parsed.error.message}`))
      }
      const manager = managerFor(ctx)
      yield* Effect.promise(() => manager.initialize(toIndexingConfigInput(parsed.data)))
      // Only kick off startIndexing() when the manager actually finished initializing - if the
      // feature is enabled but unconfigured (e.g. no API key), the manager's internal services
      // (_orchestrator, _searchService, ...) were never constructed and both startIndexing() and
      // searchIndex() throw via assertInitialized(). isFeatureConfigured gates that case.
      if (
        manager.getCurrentStatus().systemStatus === "Standby" &&
        manager.isFeatureEnabled &&
        manager.isFeatureConfigured
      ) {
        yield* Effect.promise(() => manager.startIndexing())
      }
      return manager
    })

    const search = Effect.fn("Indexing.search")(function* (input: { ctx: InstanceContext; raw: unknown; query: string }) {
      const manager = yield* ensure(input.ctx, input.raw)
      return yield* Effect.promise(() => manager.searchIndex(input.query))
    })

    const status = Effect.fn("Indexing.status")(function* (input: { ctx: InstanceContext; raw: unknown }) {
      const manager = yield* ensure(input.ctx, input.raw)
      return manager.getCurrentStatus()
    })

    return Service.of({ search, status })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node] })

export * as Indexing from "."
