import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Redact } from "@yukioshi/core/redact"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

function maskProviderConfig<T extends { provider?: unknown }>(config: T): T {
  if (config.provider === undefined) return config
  return { ...config, provider: Redact.maskProviderCredentials(config.provider) } as T
}

function restoreProviderConfig<T extends { provider?: unknown }>(current: T, next: T): T {
  if (next.provider === undefined) return next
  return { ...next, provider: Redact.restoreProviderCredentials(current.provider, next.provider) } as T
}

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return maskProviderConfig(yield* configSvc.get())
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const payload = restoreProviderConfig(yield* configSvc.get(), ctx.payload)
      yield* configSvc.update(payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return maskProviderConfig(payload)
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map((provider) =>
          Redact.maskProviderCredentials(Provider.toPublicInfo(provider)),
        ),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
