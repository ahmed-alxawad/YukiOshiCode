import { afterEach, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { generateText } from "ai"
import { Effect } from "effect"
import { ProviderV2 } from "@yukioshi/core/provider"
import { ModelV2 } from "@yukioshi/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const MESSAGE = "operated by opencode and is disabled in YukiOshi Code; use another provider"

const providerBlock = (extra: Record<string, unknown>) => ({
  npm: "@ai-sdk/openai-compatible",
  models: { m: { name: "M" } },
  options: { apiKey: "k" },
  ...extra,
})

it.instance(
  "config provider block named opencode cannot revive the provider",
  Effect.gen(function* () {
    const providers = yield* Provider.use.list()
    expect(providers[ProviderV2.ID.make("opencode")]).toBeUndefined()
    const error = yield* Provider.use.getModel(ProviderV2.ID.make("opencode"), ModelV2.ID.make("m")).pipe(Effect.flip)
    expect(error.message).toContain(MESSAGE)
  }),
  { config: { provider: { opencode: providerBlock({ api: "https://example.com/v1" }) } } },
)

it.instance(
  "custom provider pointing at an opencode host is rejected with a clear message",
  Effect.gen(function* () {
    const providers = yield* Provider.use.list()
    expect(providers[ProviderV2.ID.make("mine")]).toBeUndefined()
    const error = yield* Provider.use.getModel(ProviderV2.ID.make("mine"), ModelV2.ID.make("m")).pipe(Effect.flip)
    expect(error.message).toContain(MESSAGE)
  }),
  { config: { provider: { mine: providerBlock({ api: "https://opencode.ai/zen/v1" }) } } },
)

it.instance(
  "baseURL option redirecting a real provider to opencode.ai is rejected",
  Effect.gen(function* () {
    const error = yield* Provider.use.getModel(ProviderV2.ID.make("mine2"), ModelV2.ID.make("m")).pipe(Effect.flip)
    expect(error.message).toContain(MESSAGE)
  }),
  {
    config: {
      provider: { mine2: providerBlock({ options: { apiKey: "k", baseURL: "https://opencode.ai/zen/go/v1" } }) },
    },
  },
)

it.instance(
  "OPENCODE_API_KEY does not enable any opencode provider and --model opencode/... is refused",
  Effect.gen(function* () {
    yield* Env.use.set("OPENCODE_API_KEY", "zen-key")
    const providers = yield* Provider.use.list()
    expect(Object.keys(providers).filter((id) => id.startsWith("opencode"))).toEqual([])
    for (const id of ["opencode", "opencode-go"]) {
      const error = yield* Provider.use
        .getModel(ProviderV2.ID.make(id), ModelV2.ID.make("gpt-5-nano"))
        .pipe(Effect.flip)
      expect(error.message).toContain(MESSAGE)
    }
    expect(yield* Provider.use.getSmallModel(ProviderV2.ID.make("opencode"))).toBeUndefined()
  }),
  { config: { small_model: "opencode/gpt-5-nano" } },
)

it.instance(
  "provider fetch refuses opencode hosts even when the baseURL is only resolved at request time",
  Effect.gen(function* () {
    yield* Env.use.set("ZEN_HOST", "opencode.ai")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("sneaky"), ModelV2.ID.make("m"))
    const language = yield* provider.getLanguage(model)
    const error = yield* Effect.promise(() =>
      generateText({ model: language, prompt: "secret prompt", maxRetries: 0 }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    expect(String((error as Error)?.message ?? error)).toContain(MESSAGE)
  }),
  {
    config: {
      provider: { sneaky: providerBlock({ options: { apiKey: "k", baseURL: "https://${ZEN_HOST}/zen/v1" } }) },
    },
  },
)
