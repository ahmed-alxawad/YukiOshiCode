import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { SkillPlugin } from "@yukioshi/core/plugin/skill"
import { SkillV2 } from "@yukioshi/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-opencode skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      const skills = yield* skill.list()
      expect(skills).toContainEqual(
        expect.objectContaining({
          name: "customize-opencode",
          description: expect.stringContaining("YukiOshi's own configuration"),
        }),
      )
      const builtin = skills.find((item) => item.name === "customize-opencode")
      expect(builtin?.description).toContain("yukioshi.json")
      expect(builtin?.description).toContain(".yukioshi/")
      expect(builtin?.description).toContain("Legacy opencode.json")
      expect(builtin?.content).toContain("## yukioshi.json")
      expect(builtin?.content).toContain(".yukioshi/skills/my-skill/SKILL.md")
      expect(builtin?.content).toContain("Legacy `opencode.json` and `.opencode/` locations remain supported")
    }),
  )
})
