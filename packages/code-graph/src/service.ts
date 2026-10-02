import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { NullCodeGraphProvider } from "./providers"
import type { CodeGraphProvider } from "./contracts"

export interface CodeGraphService {
  readonly provider: CodeGraphProvider
}

export class Service extends Context.Service<Service, CodeGraphService>()("@yukioshi/CodeGraph") {}

export const layer = (provider: CodeGraphProvider = new NullCodeGraphProvider()) => Layer.succeed(Service, { provider })

export const node = LayerNode.make({
  service: Service,
  layer: Layer.succeed(Service, { provider: new NullCodeGraphProvider() }),
  deps: [],
})

export const refresh = Effect.fn("CodeGraph.refresh")(function* () {
  const service = yield* Service
  return yield* Effect.promise(() => service.provider.refresh())
})
