import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Global } from "@yukioshi/core/global"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { LayerNodePlatform } from "@yukioshi/core/effect/app-node-platform"
import { Instruction } from "../../src/session/instruction"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

// `undefined` is the yukioshi edition; "KOTHORA.md" is the Kothora edition.
const provide = (extraFile: string | undefined, global: Partial<Global.Interface>) =>
  Effect.provide(
    AppNodeBuilder.build(Instruction.nodeWith(extraFile), [
      [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
      [Global.node, Global.layerWith(global)],
      [RuntimeFlags.node, RuntimeFlags.layer({})],
    ]),
  )

const withFiles = (
  extraFile: string | undefined,
  files: Record<string, string>,
  self: (dir: string, instruction: Instruction.Interface) => Effect.Effect<void, unknown, any>,
) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      for (const [file, content] of Object.entries(files)) {
        yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
        yield* fs.writeFileString(path.join(dir, file), content)
      }
      return yield* Effect.gen(function* () {
        yield* self(dir, yield* Instruction.Service)
      }).pipe(provide(extraFile, { home: dir, config: path.join(dir, "global-config") }))
    }),
  )

describe("KOTHORA.md loading", () => {
  it.live("the Kothora edition reads KOTHORA.md first, then the first of AGENTS.md or CLAUDE.md", () =>
    withFiles("KOTHORA.md", { "KOTHORA.md": "# Kothora rules", "AGENTS.md": "# Agents rules", "CLAUDE.md": "# Claude rules" }, (dir, instruction) =>
      Effect.gen(function* () {
        const paths = Array.from(yield* instruction.systemPaths())
        expect(paths).toEqual([path.join(dir, "KOTHORA.md"), path.join(dir, "AGENTS.md")])
        const system = yield* instruction.system()
        expect(system[0]).toContain("# Kothora rules")
        expect(system[1]).toContain("# Agents rules")
        expect(system.join("\n")).not.toContain("# Claude rules")
      }),
    ),
  )

  it.live("the Kothora edition falls back to CLAUDE.md when there is no AGENTS.md", () =>
    withFiles("KOTHORA.md", { "KOTHORA.md": "k", "CLAUDE.md": "c" }, (dir, instruction) =>
      Effect.gen(function* () {
        expect(Array.from(yield* instruction.systemPaths())).toEqual([path.join(dir, "KOTHORA.md"), path.join(dir, "CLAUDE.md")])
      }),
    ),
  )

  it.live("the Kothora edition works with KOTHORA.md alone, and with no KOTHORA.md as before", () =>
    Effect.gen(function* () {
      yield* withFiles("KOTHORA.md", { "KOTHORA.md": "k" }, (dir, instruction) =>
        Effect.gen(function* () {
          expect(Array.from(yield* instruction.systemPaths())).toEqual([path.join(dir, "KOTHORA.md")])
        }),
      )
      yield* withFiles("KOTHORA.md", { "AGENTS.md": "a" }, (dir, instruction) =>
        Effect.gen(function* () {
          expect(Array.from(yield* instruction.systemPaths())).toEqual([path.join(dir, "AGENTS.md")])
        }),
      )
    }),
  )

  it.live("KOTHORA.md in the global config folder is read too", () =>
    withFiles("KOTHORA.md", { "global-config/KOTHORA.md": "g", "AGENTS.md": "a" }, (dir, instruction) =>
      Effect.gen(function* () {
        expect(Array.from(yield* instruction.systemPaths())).toEqual([
          path.join(dir, "global-config", "KOTHORA.md"),
          path.join(dir, "AGENTS.md"),
        ])
      }),
    ),
  )

  it.live("a KOTHORA.md found in a subfolder is offered when a file there is read", () =>
    withFiles("KOTHORA.md", { "AGENTS.md": "a", "sub/KOTHORA.md": "sub rules", "sub/x.ts": "x" }, (dir, instruction) =>
      Effect.gen(function* () {
        expect(yield* instruction.find(path.join(dir, "sub"))).toBe(path.join(dir, "sub", "KOTHORA.md"))
      }),
    ),
  )

  it.live("the yukioshi edition ignores KOTHORA.md, exactly as before", () =>
    withFiles(undefined, { "KOTHORA.md": "# Kothora rules", "AGENTS.md": "# Agents rules", "global-config/KOTHORA.md": "g" }, (dir, instruction) =>
      Effect.gen(function* () {
        expect(Array.from(yield* instruction.systemPaths())).toEqual([path.join(dir, "AGENTS.md")])
        expect((yield* instruction.system()).join("\n")).not.toContain("Kothora rules")
        expect(yield* instruction.find(dir)).toBe(path.join(dir, "AGENTS.md"))
      }),
    ),
  )

  it.live("the default instruction node is the yukioshi edition and does not read KOTHORA.md", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(path.join(dir, "KOTHORA.md"), "k")
        const paths = yield* Effect.gen(function* () {
          return Array.from(yield* (yield* Instruction.Service).systemPaths())
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(Instruction.node, [
              [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
              [Global.node, Global.layerWith({ home: dir, config: path.join(dir, "g") })],
              [RuntimeFlags.node, RuntimeFlags.layer({})],
            ]),
          ),
        )
        expect(paths).toEqual([])
      }),
    ),
  )
})
