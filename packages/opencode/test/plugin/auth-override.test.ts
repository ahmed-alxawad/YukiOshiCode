import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@yukioshi/core/fs-util"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { ProviderV2 } from "@yukioshi/core/provider"
import { Config } from "@/config/config"
import { Auth } from "@/auth"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(LayerNode.group([ProviderAuth.node, Auth.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "opencode.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin auth methods augment the built-in provider methods",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot.map((method) => method.label)).toContain("Test Override Auth")
        expect(copilot).toHaveLength(plainMethods[ProviderV2.ID.make("github-copilot")].length + 1)
        expect(plainMethods[ProviderV2.ID.make("github-copilot")].map((method) => method.label)).not.toContain(
          "Test Override Auth",
        )
      }),
    { git: true },
    30000,
  )

  it.instance(
    "Antigravity OAuth registered by a Google plugin completes through ProviderAuth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const apiPluginFile = path.join(tmp.directory, ".yukioshi", "plugin", "google-api-auth.ts")
        const pluginFile = path.join(tmp.directory, ".yukioshi", "plugin", "antigravity-auth.ts")

        yield* fs.writeWithDirs(
          apiPluginFile,
          [
            "export default {",
            '  id: "test.google-api-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "google",',
            '      methods: [{ type: "api", label: "Google API key" }],',
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        yield* fs.writeWithDirs(
          pluginFile,
          [
            "export default {",
            '  id: "test.antigravity-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "google",',
            "      methods: [{",
            '        type: "oauth",',
            '        label: "OAuth with Google (Antigravity)",',
            "        authorize: async () => ({",
            '          url: "https://accounts.google.test/authorize",',
            '          instructions: "Sign in with Google",',
            '          method: "code",',
            "          callback: async () => ({",
            '            type: "success",',
            '            provider: "google",',
            '            refresh: "refresh-token",',
            '            access: "access-token",',
            "            expires: 4102444800000,",
            "          }),",
            "        }),",
            "      }],",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const apiPlugin = pathToFileURL(apiPluginFile).href
        const plugin = pathToFileURL(pluginFile).href
        const result = yield* Effect.gen(function* () {
          const providerAuth = yield* ProviderAuth.Service
          const auth = yield* Auth.Service
          const methods = yield* providerAuth.methods()
          const google = methods[ProviderV2.ID.make("google")]
          const method = google.findIndex((item) => item.label === "OAuth with Google (Antigravity)")

          expect(google.map((item) => item.label)).toContain("Google API key")
          expect(method).toBeGreaterThan(0)
          expect(
            yield* providerAuth.authorize({ providerID: ProviderV2.ID.make("google"), method, inputs: {} }),
          ).toEqual({
            url: "https://accounts.google.test/authorize",
            instructions: "Sign in with Google",
            method: "code",
          })

          yield* providerAuth.callback({ providerID: ProviderV2.ID.make("google"), method, code: "oauth-code" })
          return yield* auth.get("google")
        }).pipe(Effect.provide(providerAuthLayer(tmp.directory, [apiPlugin, plugin])))

        expect(result).toMatchObject({
          type: "oauth",
          refresh: "refresh-token",
          access: "access-token",
        })
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
