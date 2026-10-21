// Shared by task.ts (an agent with isolation: worktree) and task-parallel.ts (worktree: true):
// what a task left in its git worktree, and the rule that a worktree with changes is kept.
import { Effect } from "effect"
import type { Git } from "@/git"
import type { Worktree } from "../worktree"

export type Kept = { name: string; branch?: string; changed: number; commits: number }

// The worktree as the task received it: its commit, and the ignored paths already there (dependencies a
// start command installed, say), so only what the task itself left counts as its work.
export type Start = { head: string | undefined; ignored: ReadonlySet<string> }

const IGNORED = "!! "

export const worktreeTools = (git: Git.Interface, worktree: Worktree.Interface) => {
  const output = (args: string[], cwd: string) =>
    git.run(args, { cwd }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : undefined)))

  // Plain `status --porcelain` hides ignored files, and `worktree remove --force` deletes them, so a task
  // that only wrote reports, .env or build output into ignored paths would lose that work.
  const statusLines = (directory: string) =>
    output(["status", "--porcelain", "--ignored"], directory).pipe(
      Effect.map((status) => status?.split("\n").filter((line) => line.trim() !== "")),
    )

  const start = Effect.fnUntraced(function* (directory: string) {
    const lines = yield* statusLines(directory)
    const head = yield* output(["rev-parse", "HEAD"], directory)
    return { head, ignored: new Set(lines?.filter((line) => line.startsWith(IGNORED))) } satisfies Start
  })

  // What a task left in its worktree: uncommitted changes (new ignored files included), and commits made
  // after it was created.
  const changes = Effect.fnUntraced(function* (directory: string, from: Start) {
    const lines = yield* statusLines(directory)
    const commits = from.head ? yield* output(["rev-list", "--count", `${from.head}..HEAD`], directory) : undefined
    return {
      // An unreadable status counts as a change, so a worktree is never deleted on a guess.
      changed: lines === undefined ? 1 : lines.filter((line) => !from.ignored.has(line)).length,
      commits: Number(commits ?? 0) || 0,
    }
  })

  // A worktree whose task changed nothing is removed; one with changes is kept, on its own branch.
  // A cleanup failure is only logged, so it never replaces the task's own result.
  const settle = Effect.fnUntraced(function* (info: Worktree.Info, from: Start, label: string) {
    const left = yield* changes(info.directory, from)
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

  return { output, start, changes, settle }
}
