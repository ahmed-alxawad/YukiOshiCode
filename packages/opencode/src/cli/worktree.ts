// `--worktree [name]` for `yukioshi` and `yukioshi run`: start the session in a git worktree of the current
// project, so parallel sessions never edit the same files. A worktree with that name is reused; otherwise
// one is created (on branch yukioshi/<name>) and its files are checked out before the session starts.

import { Effect } from "effect"
import { Worktree } from "@/worktree"

/** The name a worktree gets for `name`, the same way the worktree service derives it. */
export function worktreeSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

/** Finds the worktree called `name`, or creates it (a generated name when none is given). */
export const resolveWorktree = Effect.fn("Cli.resolveWorktree")(function* (name: string | undefined) {
  const worktrees = yield* Worktree.Service
  const wanted = name?.trim() ? worktreeSlug(name) : undefined
  if (wanted) {
    const existing = (yield* worktrees.list()).find((item) => item.name === wanted)
    if (existing) return { ...existing, created: false }
  }
  const info = yield* worktrees.createReady({ name: wanted })
  return { ...info, created: true }
})

/**
 * The same, for commands that run outside a project instance (the terminal UI): loads the project at
 * `directory`, resolves the worktree, and returns its folder.
 */
export async function worktreeDirectory(name: string | undefined, directory: string) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { InstanceStore } = await import("@/project/instance-store")
  const { InstanceRef } = await import("@/effect/instance-ref")
  const { store, ctx } = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) => store.load({ directory }).pipe(Effect.map((ctx) => ({ store, ctx })))),
  )
  try {
    return await AppRuntime.runPromise(resolveWorktree(name).pipe(Effect.provideService(InstanceRef, ctx)))
  } finally {
    await AppRuntime.runPromise(store.dispose(ctx))
  }
}
