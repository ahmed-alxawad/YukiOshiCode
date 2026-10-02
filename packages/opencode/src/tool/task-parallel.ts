// Parallel/worktree-isolated subagent orchestration, inspired by Kilo Code's "Agent Manager"
// (packages/opencode/src/kilocode/tool/agent-manager.ts and kilocode/agent-manager/*, MIT
// License) but implemented as a thin composition over opencode's own existing primitives rather
// than a port: opencode already has a single-subagent task tool (./task.ts, with background
// mode and resume support) and a full native git worktree service (../worktree). This tool just
// runs several task.ts invocations concurrently, optionally giving each its own worktree via
// InstanceStore.provide so parallel subagents can't collide on the same working tree - it does
// not replicate Kilo's own Agent Manager board/host-process/batch-versions-comparison UI.
import { Cause, Effect, Exit, Schema } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "../worktree"
import * as Tool from "./tool"
import { TaskTool } from "./task"

const DESCRIPTION =
  "Run multiple subagent tasks concurrently. Each task runs like the task tool, but set worktree=true on a task to give it its own isolated git worktree so it can edit files without colliding with other parallel tasks or the current session (requires a git repository). Use this instead of sequential task calls when the tasks are independent of each other."

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

function render(input: { index: number; description: string; worktree?: string }, outcome: string) {
  return [
    `<parallel_task index="${input.index}" description=${JSON.stringify(input.description)}${
      input.worktree ? ` worktree=${JSON.stringify(input.worktree)}` : ""
    }>`,
    outcome,
    "</parallel_task>",
  ].join("\n")
}

export const TaskParallelTool = Tool.define(
  "task_parallel",
  Effect.gen(function* () {
    const taskToolInfo = yield* TaskTool
    const worktree = yield* Worktree.Service
    const store = yield* InstanceStore.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const taskDef = yield* Tool.init(taskToolInfo)

          // Track worktrees that were successfully created so we can always clean them up,
          // even when the task itself fails (the outcome won't carry .worktree in that case).
          const createdWorktrees = new Map<number, string>()

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
            const info = yield* worktree.create({ name: task.description })
            createdWorktrees.set(index, info.directory)
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

          // Clean up every worktree that was created, regardless of whether its task succeeded
          // or failed. A cleanup failure must not mask or replace the task's own result, so we
          // log a warning and swallow the error rather than surfacing it to the caller.
          yield* Effect.all(
            Array.from(createdWorktrees.entries()).map(([index, directory]) =>
              worktree
                .remove({ directory })
                .pipe(
                  Effect.catch((err: Worktree.Error) =>
                    Effect.logWarning("task_parallel: failed to remove worktree after task", {
                      index,
                      directory,
                      error: err.message,
                    }),
                  ),
                ),
            ),
            { concurrency: "unbounded", discard: true },
          )

          const blocks = outcomes.map((outcome, index) => {
            const task = params.tasks[index]!
            if (Exit.isFailure(outcome)) {
              const failure = Cause.squash(outcome.cause)
              return render(
                { index, description: task.description },
                `<task_error>${failure instanceof Error ? failure.message : String(failure)}</task_error>`,
              )
            }
            return render(
              { index, description: task.description, worktree: outcome.value.worktree },
              outcome.value.result.output,
            )
          })

          const failed = outcomes.filter((outcome) => Exit.isFailure(outcome)).length
          return {
            title: `${params.tasks.length} parallel task${params.tasks.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
            output: blocks.join("\n\n"),
            metadata: { count: params.tasks.length, failed },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
