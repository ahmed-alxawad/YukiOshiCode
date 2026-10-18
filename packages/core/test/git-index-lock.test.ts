import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Git } from "@yukioshi/core/git"
import { AbsolutePath } from "@yukioshi/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git index lock recovery", () => {
  it.live("removes only an old unheld lock and preserves fresh or held locks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")

      const lock = path.join(root.path, ".git", "index.lock")
      const old = new Date(Date.now() - 61_000)
      yield* Effect.promise(async () => {
        await fs.writeFile(lock, "stale")
        await fs.utimes(lock, old, old)
      })
      yield* git.history.head(repository)
      expect(yield* Effect.promise(() => fs.stat(lock).catch(() => undefined))).toBeUndefined()

      yield* Effect.promise(async () => {
        await fs.writeFile(lock, "fresh")
        const now = new Date()
        await fs.utimes(lock, now, now)
      })
      yield* git.history.head(repository)
      expect(yield* Effect.promise(() => fs.readFile(lock, "utf8"))).toBe("fresh")

      const holder = Bun.spawn(["tail", "-f", lock], { stdout: "ignore", stderr: "ignore" })
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      yield* Effect.promise(async () => fs.utimes(lock, old, old))
      yield* git.history.head(repository)
      expect(yield* Effect.promise(() => fs.readFile(lock, "utf8"))).toBe("fresh")
      holder.kill()
      yield* Effect.promise(() => holder.exited)
      yield* Effect.promise(() => fs.rm(lock, { force: true }))
    }),
  )
})
