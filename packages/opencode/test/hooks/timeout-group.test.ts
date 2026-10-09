import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), []))
const posix = process.platform === "win32" ? it.live.skip : it.live

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("Hooks timeout", () => {
  posix("kills background grandchildren of a timed-out hook", () =>
    Effect.gen(function* () {
      const cwd = yield* tmpdirScoped()
      const pidFile = path.join(cwd, "child.pid")
      const hooks = yield* Hooks.Service
      const cfg: ConfigHooksV1.Info = {
        preToolUse: [{ matcher: "*", command: `sleep 60 & echo $! > "${pidFile}"; wait`, timeoutMs: 1000 }],
      }
      const result = yield* hooks.run({ hooks: cfg, event: "PreToolUse", payload: {}, cwd, toolName: "bash" })
      expect(result.warnings.join("\n")).toContain("timed out")
      const pid = Number((yield* Effect.promise(() => fs.readFile(pidFile, "utf8"))).trim())
      expect(pid).toBeGreaterThan(0)
      yield* Effect.promise(() => Bun.sleep(300))
      expect(alive(pid)).toBe(false)
    }),
  )
})
