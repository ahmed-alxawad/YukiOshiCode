// Parallel/worktree-isolated subagent orchestration, inspired by Kilo Code's "Agent Manager"
// (packages/opencode/src/kilocode/tool/agent-manager.ts and kilocode/agent-manager/*, MIT
// License) but implemented as a thin composition over opencode's own existing primitives rather
// than a port: opencode already has a single-subagent task tool (./task.ts, with background
// mode and resume support) and a full native git worktree service (../worktree). This tool just
// runs several task.ts invocations concurrently, optionally giving each its own worktree via
// InstanceStore.provide so parallel subagents can't collide on the same working tree - it does
// not replicate Kilo's own Agent Manager board/host-process/batch-versions-comparison UI.
import { Cause, Effect, Exit, Schema } from "effect"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "../worktree"
import * as Tool from "./tool"
import { TaskTool } from "./task"

const DESCRIPTION =
  "Run multiple subagent tasks concurrently. Each task runs like the task tool, but set worktree=true on a task to give it its own isolated git worktree so it can edit files without colliding with other parallel tasks or the current session (requires a git repository). A worktree task's changes stay in its worktree, on its own branch, and the result says where; they are not applied to the current checkout. Use this instead of sequential task calls when the tasks are independent of each other."

const TaskSpec = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of this task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description: "Run this task in its own isolated git worktree (requires a git repository)",
  }),
})

export const Parameters = Schema.Struct({
  tasks: Schema.Array(TaskSpec).check(Schema.isMinLength(1), Schema.isMaxLength(8)).annotate({
    description: "Tasks to run concurrently (1-8)",
  }),
})

const CONCURRENCY = 4

type Kept = { name: string; branch?: string; changed: number; commits: number }

function render(input: { index: number; description: string; worktree?: string; kept?: Kept }, outcome: string) {
  const kept = input.kept
  const counts = kept && [
    ...(kept.changed ? [`${kept.changed} changed file${kept.changed === 1 ? "" : "s"}`] : []),
    ...(kept.commits ? [`${kept.commits} new commit${kept.commits === 1 ? "" : "s"}`] : []),
  ]
  return [
    `<parallel_task index="${input.index}" description=${JSON.stringify(input.description)}${
      input.worktree ? ` worktree=${JSON.stringify(input.worktree)}` : ""
    }${kept?.branch ? ` branch=${JSON.stringify(kept.branch)}` : ""}${kept ? ` kept="true"` : ""}>`,
    outcome,
    ...(kept && input.worktree
      ? [
          `<worktree_changes>This task's changes (${counts!.join(", ")}) were kept in ${input.worktree}${
            kept.branch ? ` on branch ${kept.branch}` : ""
          }, not in the current checkout. Review them with git -C ${JSON.stringify(input.worktree)} status and diff, and bring in what is wanted. The worktree can be deleted afterwards with: yukioshi worktree remove ${kept.name}</worktree_changes>`,
        ]
      : []),
    "</parallel_task>",
  ].join("\n")
}

export const TaskParallelTool = Tool.define(
  "task_parallel",
  Effect.gen(function* () {
    const taskToolInfo = yield* TaskTool
    const worktree = yield* Worktree.Service
    const store = yield* InstanceStore.Service
    const git = yield* Git.Service

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

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const taskDef = yield* Tool.init(taskToolInfo)

          // Track worktrees that were successfully created so each one is looked at afterwards,
          // even when the task itself fails (the outcome won't carry .worktree in that case).
          const createdWorktrees = new Map<number, { info: Worktree.Info; base?: string }>()

          const run = Effect.fn("TaskParallelTool.run")(function* (
            task: Schema.Schema.Type<typeof TaskSpec>,
            index: number,
          ) {
            const invoke = () =>
              taskDef.execute(
                { description: task.description, prompt: task.prompt, subagent_type: task.subagent_type },
                ctx,
              )
            if (!task.worktree) return { index, worktree: undefined as string | undefined, result: yield* invoke() }
            // createReady checks the files out before returning, so the subagent never starts in an empty folder.
            const info = yield* worktree.createReady({ name: task.description })
            createdWorktrees.set(index, { info, base: yield* output(["rev-parse", "HEAD"], info.directory) })
            const result = yield* store.provide({ directory: info.directory }, invoke())
            return { index, worktree: info.directory, result }
          })

          // task.ts (like every Tool.execute) dies rather than fails on error (see
          // Tool.wrap's Effect.orDie in ./tool.ts), so a per-task failure is a defect, not a
          // typed error - Effect.exit/Cause.squash is what actually catches it; Effect.result
          // only inspects the typed error channel and would let the defect crash the whole batch.
          const outcomes = yield* Effect.all(
            params.tasks.map((task, index) => run(task, index).pipe(Effect.exit)),
            { concurrency: CONCURRENCY },
          )

          // A worktree whose task changed nothing is removed. One with changes is kept, on its own branch,
          // because removing it would delete the task's work; the result tells the agent where it is.
          // A cleanup failure must not mask or replace the task's own result, so it is only logged.
          const kept = new Map<number, Kept>()
          yield* Effect.all(
            Array.from(createdWorktrees.entries()).map(([index, { info, base }]) =>
              Effect.gen(function* () {
                const left = yield* changes(info.directory, base)
                if (left.changed || left.commits) {
                  kept.set(index, { name: info.name, branch: info.branch, ...left })
                  return
                }
                yield* worktree.remove({ directory: info.directory }).pipe(
                  Effect.catch((err: Worktree.Error) =>
                    Effect.logWarning("task_parallel: failed to remove worktree after task", {
                      index,
                      directory: info.directory,
                      error: err.message,
                    }),
                  ),
                )
              }),
            ),
            { concurrency: "unbounded", discard: true },
          )

          const blocks = outcomes.map((outcome, index) => {
            const task = params.tasks[index]!
            const created = createdWorktrees.get(index)
            const where = { worktree: created?.info.directory, kept: kept.get(index) }
            if (Exit.isFailure(outcome)) {
              const failure = Cause.squash(outcome.cause)
              return render(
                { index, description: task.description, ...where },
                `<task_error>${failure instanceof Error ? failure.message : String(failure)}</task_error>`,
              )
            }
            return render({ index, description: task.description, ...where }, outcome.value.result.output)
          })

          const failed = outcomes.filter((outcome) => Exit.isFailure(outcome)).length
          return {
            title: `${params.tasks.length} parallel task${params.tasks.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
            output: blocks.join("\n\n"),
            metadata: { count: params.tasks.length, failed, kept: kept.size },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
