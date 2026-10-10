import { expect } from "bun:test"
import { streamText } from "ai"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ModelsDev } from "@yukioshi/core/models-dev"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { ProviderV2 } from "@yukioshi/core/provider"
import { ModelV2 } from "@yukioshi/core/model"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestLLMServer } from "../lib/llm-server"
import { testEffect } from "../lib/effect"
import { provideTmpdirServer } from "../fixture/fixture"

const testLLMServerNode = LayerNode.make({
  service: TestLLMServer,
  layer: TestLLMServer.layer,
  deps: [],
})

const providerLayer = LayerNode.compile(
  LayerNode.group([
    Provider.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Env.node,
    Config.node,
    Auth.node,
    Plugin.node,
    ModelsDev.node,
    RuntimeFlags.node,
    testLLMServerNode,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(providerLayer)

it.live(
  "Google AI Studio preset sends a request through a configured OpenAI-compatible endpoint",
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        yield* llm.text("Google AI Studio response")

        const provider = yield* Provider.Service
        const model = yield* provider.getModel(ProviderV2.ID.make("google-ai-studio"), ModelV2.ID.make("fake-model"))
        const language = yield* provider.getLanguage(model)
        const result = streamText({
          model: language,
          prompt: "Say hello",
          maxRetries: 0,
        })

        expect(yield* Effect.promise(() => result.text)).toBe("Google AI Studio response")
        expect((yield* llm.inputs)[0]?.model).toBe("fake-model")
        expect((yield* llm.hits)[0]?.url.pathname).toBe("/v1/chat/completions")
      }),
    {
      config: (url) => ({
        model: "google-ai-studio/fake-model",
        enabled_providers: ["google-ai-studio"],
        provider: {
          "google-ai-studio": {
            name: "Google AI Studio",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "fake-model": {
                name: "Fake model",
                limit: { context: 128000, output: 4096 },
              },
            },
            options: {
              apiKey: "google-test-key",
              baseURL: url,
            },
          },
        },
      }),
    },
  ),
  30_000,
)
