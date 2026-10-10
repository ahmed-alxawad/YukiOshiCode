import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import { MessageID } from "../../src/session/schema"
import { Global } from "@yukioshi/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { LayerNodePlatform } from "@yukioshi/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      const globalDir = yield* tmpdirScoped()
      return yield* self(dir).pipe(provideInstruction({ home: globalDir, config: globalDir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

const link = (target: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.symlink(target, file)
  })

describe("Instruction files that are symlinks out of the project", () => {
  it.live("does not load a project AGENTS.md symlinked to a file outside the project", () =>
    withFiles({}, (dir) =>
      Effect.gen(function* () {
        const outside = yield* tmpWithFiles({ "secret.txt": "TOP-SECRET-ROOT" })
        yield* link(path.join(outside, "secret.txt"), path.join(dir, "AGENTS.md"))

        const svc = yield* Instruction.Service
        const system = yield* svc.system()

        expect(system.join("\n")).not.toContain("TOP-SECRET-ROOT")
      }),
    ),
  )

  it.live("does not attach a nested AGENTS.md symlinked to a file outside the project", () =>
    withFiles({ "sub/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const outside = yield* tmpWithFiles({ "secret.txt": "TOP-SECRET-NESTED" })
        yield* link(path.join(outside, "secret.txt"), path.join(dir, "sub", "AGENTS.md"))

        const svc = yield* Instruction.Service
        const results = yield* svc.resolve([], path.join(dir, "sub", "file.ts"), MessageID.make("msg_message-link-1"))

        expect(results.map((item) => item.content).join("\n")).not.toContain("TOP-SECRET-NESTED")
      }),
    ),
  )

  it.live("does not load a relative instructions entry that is a symlink out of the project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpWithFiles({ "docs/ok.md": "DOCS-OK" })
      const outside = yield* tmpWithFiles({ "secret.txt": "TOP-SECRET-CONFIG" })
      yield* link(path.join(outside, "secret.txt"), path.join(dir, "docs", "rules.md"))
      const cfg = Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ instructions: ["docs/*.md"] }) }))
      const layer = AppNodeBuilder.build(Instruction.node, [
        [Config.node, cfg],
        [Global.node, Global.layerWith({ home: outside, config: outside })],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
      ])
      const system = yield* provideInstance(dir)(
        Effect.gen(function* () {
          return yield* (yield* Instruction.Service).system()
        }).pipe(Effect.provide(layer)),
      )

      expect(system.join("\n")).toContain("DOCS-OK")
      expect(system.join("\n")).not.toContain("TOP-SECRET-CONFIG")
    }),
  )

  it.live("still loads ordinary instruction files", () =>
    withFiles({ "AGENTS.md": "ROOT-OK", "sub/AGENTS.md": "SUB-OK", "sub/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.system()
        const results = yield* svc.resolve([], path.join(dir, "sub", "file.ts"), MessageID.make("msg_message-link-2"))

        expect(system.join("\n")).toContain("ROOT-OK")
        expect(results.map((item) => item.content).join("\n")).toContain("SUB-OK")
      }),
    ),
  )
})
