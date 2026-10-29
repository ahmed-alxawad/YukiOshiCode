import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { resolve } from "@yukioshi/core/edition"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const skills = (edition: ReturnType<typeof resolve>) =>
  testEffect(Layer.mergeAll(LayerNode.compile(Skill.nodeWith(edition)), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

const kothora = skills(resolve("kothora", undefined))
const yukioshi = skills(resolve("yukioshi", undefined))

const NAMES = ["bangla-interface-helper", "freelancer-pack"]

describe("kothora edition: built-in skills", () => {
  kothora.instance("both skills are discovered and counted as built in", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        for (const name of NAMES) {
          const info = yield* skill.get(name)
          expect(info?.description?.length).toBeGreaterThan(40)
          expect(Skill.isBuiltin(info!)).toBe(true)
        }
      }),
    ),
  )

  yukioshi.instance("the yukioshi edition does not list them", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const names = (yield* skill.all()).map((info) => info.name)
        for (const name of NAMES) expect(names).not.toContain(name)
      }),
    ),
  )

  kothora.instance("a project skill with the same name does not replace them", () =>
    provideTmpdirInstance(
      (dir) =>
      Effect.gen(function* () {
        const folder = path.join(dir, ".claude", "skills", "freelancer-pack")
        yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(path.join(folder, "SKILL.md"), "---\nname: freelancer-pack\ndescription: Mine.\n---\nMine\n"),
        )
        const skill = yield* Skill.Service
        expect(Skill.isBuiltin((yield* skill.get("freelancer-pack"))!)).toBe(true)
        expect((yield* skill.get("project:freelancer-pack"))?.description).toBe("Mine.")
      }),
      { git: true },
    ),
  )

  kothora.instance("the skill files are in the repo's SKILL.md format: the folder name is the skill name", () =>
    Effect.promise(async () => {
      for (const name of NAMES) {
        const text = await Bun.file(path.join(Skill.EDITION_SKILLS_DIR, name, "SKILL.md")).text()
        expect(text.startsWith(`---\nname: ${name}\ndescription: `)).toBe(true)
        expect(text.split("\n---\n")[0].length).toBeLessThan(700)
      }
    }),
  )
})
