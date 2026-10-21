import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Global } from "@yukioshi/core/global"
import { Config } from "@/config/config"
import { provideTmpdirInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Format } from "../../src/format"
import * as Formatter from "../../src/format/formatter"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
)

describe("Format", () => {
  it.instance("status() returns empty list when no formatters are configured", () =>
    Format.Service.use((fmt) =>
      Effect.gen(function* () {
        expect(yield* fmt.status()).toEqual([])
      }),
    ),
  )

  it.instance(
    "status() returns built-in formatters when formatter is true",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
        }),
      ),
    { config: { formatter: true } },
  )

  it.instance(
    "status() keeps built-in formatters when config object is provided",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: {} } } },
  )

  it.instance(
    "status() excludes formatters marked as disabled in config",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeUndefined()
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: { disabled: true } } } },
  )

  it.instance(
    "status() excludes uv when ruff is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { ruff: { disabled: true } } } },
  )

  it.instance(
    "status() excludes ruff when uv is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { uv: { disabled: true } } } },
  )

  it.instance("service initializes without error", () => Format.Service.use(() => Effect.void))

  it.instance(
    "file() returns false when no formatter runs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.txt`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const formatted = yield* Format.use.file(file)
        expect(formatted).toBe(false)
      }),
    { config: { formatter: false } },
  )

  testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])),
      NodeFileSystem.layer,
      testInstanceStoreLayer,
    ),
  ).live("status() initializes formatter state per directory", () =>
    Effect.gen(function* () {
      const a = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: { formatter: false },
      })
      const b = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: {
          formatter: true,
        },
      })

      expect(a).toEqual([])
      expect(b.find((item) => item.name === "gofmt")).toBeDefined()
    }),
  )

  it.instance(
    "runs enabled checks for matching formatters in parallel",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.parallel`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const one = {
          extensions: Formatter.gofmt.extensions,
          enabled: Formatter.gofmt.enabled,
        }
        const two = {
          extensions: Formatter.mix.extensions,
          enabled: Formatter.mix.enabled,
        }

        let active = 0
        let max = 0

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            Formatter.gofmt.extensions = [".parallel"]
            Formatter.mix.extensions = [".parallel"]
            Formatter.gofmt.enabled = async () => {
              active++
              max = Math.max(max, active)
              await Promise.resolve()
              active--
              return ["sh", "-c", "true"]
            }
            Formatter.mix.enabled = async () => {
              active++
              max = Math.max(max, active)
              await Promise.resolve()
              active--
              return ["sh", "-c", "true"]
            }
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                yield* fmt.init()
                yield* fmt.file(file)
              }),
            ),
          () =>
            Effect.sync(() => {
              Formatter.gofmt.extensions = one.extensions
              Formatter.gofmt.enabled = one.enabled
              Formatter.mix.extensions = two.extensions
              Formatter.mix.enabled = two.enabled
            }),
        )

        expect(max).toBe(2)
      }),
    { config: { formatter: { gofmt: {}, mix: {} } } },
  )

  it.instance(
    "runs matching formatters sequentially for the same file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.seq`
        yield* Effect.promise(() => Bun.write(file, "x"))

        yield* Format.Service.use((fmt) =>
          Effect.gen(function* () {
            yield* fmt.init()
            expect(yield* fmt.file(file)).toBe(true)
          }),
        )

        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("xAB")
      }),
    {
      config: {
        formatter: {
          first: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'A')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
          second: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'B')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
        },
      },
    },
  )

  testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Format.node, Config.node, CrossSpawnSpawner.node])),
      NodeFileSystem.layer,
      testInstanceStoreLayer,
    ),
  ).live("an untrusted project's own vendor/bin/pint never runs, even with formatters on globally", () =>
    Effect.gen(function* () {
      const global = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(global, "yukioshi.json"), JSON.stringify({ formatter: true })))
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = global
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => ((Global.Path as { config: string }).config = previous)).pipe(
          Effect.andThen(Config.use.invalidate()),
        ),
      )
      yield* Config.use.invalidate()

      const marker = path.join(global, "pint-ran")
      const formatted = yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await Bun.write(path.join(dir, "composer.json"), JSON.stringify({ "require-dev": { "laravel/pint": "^1" } }))
              await fs.mkdir(path.join(dir, "vendor", "bin"), { recursive: true })
              await fs.writeFile(path.join(dir, "vendor", "bin", "pint"), `#!/bin/sh\necho ran > "${marker}"\n`, {
                mode: 0o755,
              })
              await Bun.write(path.join(dir, "a.php"), "<?php echo 1;\n")
            })
            return yield* Format.use.file(path.join(dir, "a.php"))
          }),
        { trusted: false },
      )

      expect(formatted).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )
})
