import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { filesystem } from "@yukioshi/core/effect/app-node-platform"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Effect } from "effect"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

describe("truncated tool output files", () => {
  it.live("the full output saved on disk holds no secret", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const fsys = yield* FSUtil.Service
      const filler = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
      const text = `OPENAI_API_KEY=${openai}\n${filler}\ntoken: ${github}\nurl=https://u:${github}@example.com/x\n`

      const result = yield* svc.output(text)
      expect(result.truncated).toBe(true)
      if (!result.truncated) return

      const saved = yield* fsys.readFileString(result.outputPath)
      expect(saved).not.toContain(openai)
      expect(saved).not.toContain(github)
      expect(saved).toContain("[REDACTED:")
      expect(saved).toContain("line 2999")
    }),
  )

  it.live("write masks secrets too", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const fsys = yield* FSUtil.Service
      const file = yield* svc.write(`export GITHUB_TOKEN=${github}\n`)
      expect(yield* fsys.readFileString(file)).not.toContain(github)
    }),
  )
})
