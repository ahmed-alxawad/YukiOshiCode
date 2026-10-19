import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Format } from "../../src/format"
import * as Formatter from "../../src/format/formatter"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The stub formatter hangs until killed and records its pid to verify termination.
describe("formatter time limit", () => {
  it.instance(
    "a formatter that never ends is killed at the limit and the edit goes on",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/stuck.mix`
        const pidFile = `${test.directory}/formatter.pid`
        yield* Effect.promise(() => Bun.write(file, "x"))
        const saved = { extensions: Formatter.mix.extensions, enabled: Formatter.mix.enabled }
        const prev = process.env.YUKIOSHI_FORMATTER_TIMEOUT_SECONDS
        process.env.YUKIOSHI_FORMATTER_TIMEOUT_SECONDS = "2"
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            Formatter.mix.extensions = [".mix"]
            Formatter.mix.enabled = async () => [
              process.execPath,
              "-e",
              'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
              pidFile,
            ]
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                yield* fmt.init()
                const started = Date.now()
                yield* fmt.file(file)
                expect(Date.now() - started).toBeLessThan(20_000)
              }),
            ),
          () =>
            Effect.sync(() => {
              Formatter.mix.extensions = saved.extensions
              Formatter.mix.enabled = saved.enabled
              if (prev === undefined) delete process.env.YUKIOSHI_FORMATTER_TIMEOUT_SECONDS
              else process.env.YUKIOSHI_FORMATTER_TIMEOUT_SECONDS = prev
            }),
        )
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
        yield* Effect.promise(async () => {
          const until = Date.now() + 5_000
          while (alive(pid) && Date.now() < until) await Bun.sleep(100)
        })
        expect(alive(pid)).toBe(false)
      }),
    { config: { formatter: { mix: {} } } },
  )
})
