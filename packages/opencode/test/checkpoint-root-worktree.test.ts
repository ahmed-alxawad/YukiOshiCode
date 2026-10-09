import { describe, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { writeFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Checkpoint } from "@/checkpoint"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const checkpointLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      Checkpoint.node,
      Config.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)

const it = testEffect(checkpointLayer)

describe("checkpoint in session where worktree is root", () => {
  it.live("uses ctx.directory when ctx.worktree is /", () =>
    Effect.gen(function* () {
      // In a non-git directory, Project resolution assigns worktree: "/" (the global project)
      const tmp = yield* tmpdirScoped({ git: false, config: { checkpoints: { enabled: true } } })

      const program = Effect.gen(function* () {
        const ctx = yield* InstanceRef
        expect(ctx?.worktree).toBe("/")
        expect(ctx?.directory).toBe(tmp)

        // Initialize git in the workspace directory while the session's worktree is "/"
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp })
        execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp })
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: tmp })
        writeFileSync(path.join(tmp, "file.txt"), "version 1")
        execFileSync("git", ["add", "."], { cwd: tmp })
        execFileSync("git", ["commit", "-qm", "initial"], { cwd: tmp })

        const cp = yield* Checkpoint.Service

        // Modify a file so there are working tree changes to checkpoint
        writeFileSync(path.join(tmp, "file.txt"), "version 2")

        // Create checkpoint: should resolve root to ctx.directory (tmp), NOT ctx.worktree ("/")
        const created = yield* cp.create({ sessionID: "ses_root_test", prompt: "first checkpoint" })
        expect(created).toBeDefined()
        expect(created?.root).toBe(tmp)
        expect(created?.turn).toBe(1)

        // List checkpoints: must run against ctx.directory
        const list = yield* cp.list("ses_root_test")
        expect(list).toHaveLength(1)
        expect(list[0]?.id).toBe(created!.id)

        // Show checkpoint: must show details from ctx.directory
        const shown = yield* cp.show(created!.id.slice(0, 12))
        expect(shown).toContain("first checkpoint")

        // Modify file again, then restore previous checkpoint
        writeFileSync(path.join(tmp, "file.txt"), "dirty edit")
        const restoredRoot = yield* cp.restore({
          id: created!.id.slice(0, 12),
          sessionID: "ses_safety",
          yes: true,
        })
        expect(restoredRoot).toBe(tmp)
        expect(readFileSync(path.join(tmp, "file.txt"), "utf8")).toBe("version 2")
      })

      yield* program.pipe(provideInstance(tmp))
    }),
  )
})
