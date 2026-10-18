// Shared by task.ts (an agent with isolation: worktree) and task-parallel.ts (worktree: true):
// what a task left in its git worktree, and the rule that a worktree with changes is kept.
import { Effect } from "effect"
import type { Git } from "@/git"
import type { Worktree } from "../worktree"

export type Kept = { name: string; branch?: string; changed: number; commits: number }

export const worktreeTools = (git: Git.Interface, worktree: Worktree.Interface) => {
  const output = (args: string[], cwd: string) =>
    git.run(args, { cwd }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : undefined)))

  // What a task left in its worktree: uncommitted changes, and commits made after it was created.
  const changes = Effect.fnUntraced(function* (directory: string, base: string | undefined) {
    const status = yield* output(["status", "--porcelain"], directory)
    const commits = base ? yield* output(["rev-list", "--count", `${base}..HEAD`], directory) : undefined
    return {
      // An unreadable status counts as a change, so a worktree is never deleted on a guess.
      changed: status === undefined ? 1 : status.split("\n").filter((line) => line.trim() !== "").length,
      commits: Number(commits ?? 0) || 0,
    }
  })

  // A worktree whose task changed nothing is removed; one with changes is kept, on its own branch.
  // A cleanup failure is only logged, so it never replaces the task's own result.
  const settle = Effect.fnUntraced(function* (info: Worktree.Info, base: string | undefined, label: string) {
    const left = yield* changes(info.directory, base)
    if (left.changed || left.commits) return { name: info.name, branch: info.branch, ...left } satisfies Kept
    yield* worktree.remove({ directory: info.directory }).pipe(
      Effect.catch((err: Worktree.Error) =>
        Effect.logWarning(`${label}: failed to remove worktree after task`, {
          directory: info.directory,
          error: err.message,
        }),
      ),
    )
    return undefined
  })

  return { output, changes, settle }
}
