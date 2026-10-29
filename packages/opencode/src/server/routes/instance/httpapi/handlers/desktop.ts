import * as InstanceState from "@/effect/instance-state"
import { Vcs } from "@/project/vcs"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Effect, Fiber, Scope } from "effect"
import path from "path"
import fs from "fs/promises"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { DesktopTaskNotFoundError, DesktopWorkspaceError } from "../groups/desktop"

type Task = {
  readonly taskId: string
  readonly sessionID: Parameters<SessionPrompt.Interface["cancel"]>[0]
  readonly workspace: string
  status: "running" | "complete" | "failed" | "cancelled"
  error?: string
  fiber?: Fiber.Fiber<unknown, unknown>
}

// The desktop bridge is a single-workspace process. Keeping this registry process-local
// prevents task identifiers from becoming a cross-workspace lookup capability.
const tasks = new Map<string, Task>()
let latestTask: Task | undefined

const canonical = (value: string) =>
  Effect.tryPromise({
    try: () => fs.realpath(value),
    catch: () => new DesktopWorkspaceError({ message: "Desktop workspace is unavailable" }),
  })

const requireDesktopWorkspace = Effect.fn("DesktopHttpApi.requireWorkspace")(function* () {
  const configured = process.env.KOTHORA_DESKTOP_WORKSPACE
  if (!configured || !path.isAbsolute(configured)) {
    return yield* new DesktopWorkspaceError({ message: "Desktop workspace is not configured" })
  }
  const context = yield* InstanceState.context
  const [expected, actual] = yield* Effect.all([canonical(configured), canonical(context.directory)])
  if (expected !== actual) {
    return yield* new DesktopWorkspaceError({ message: "Request is outside the desktop workspace" })
  }
  return expected
})

const publicTask = (task: Task) => ({
  taskId: task.taskId,
  status: task.status,
  ...(task.error ? { error: task.error } : {}),
})

export const desktopHandlers = HttpApiBuilder.group(InstanceHttpApi, "desktop", (handlers) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const statuses = yield* SessionStatus.Service
    const scope = yield* Scope.Scope

    const changes = Effect.fn("DesktopHttpApi.changes")(function* () {
      yield* requireDesktopWorkspace()
      return yield* vcs.status()
    })

    const diff = Effect.fn("DesktopHttpApi.diff")(function* (ctx: {
      query: { path?: string; source?: "git" | "session" }
    }) {
      const workspace = yield* requireDesktopWorkspace()
      const source = ctx.query.source ?? "git"
      const result: Vcs.FileDiff[] =
        source === "session" && latestTask?.workspace === workspace
          ? (yield* sessions.diff(latestTask.sessionID)).flatMap((item) =>
              item.file
                ? [{ ...item, file: item.file, additions: item.additions ?? 0, deletions: item.deletions ?? 0 }]
                : [],
            )
          : source === "session"
            ? []
            : yield* vcs.diff("git")
      if (!ctx.query.path) return result
      const requested = ctx.query.path.replaceAll("\\", "/")
      return result.filter((item) => item.file === requested)
    })

    const create = Effect.fn("DesktopHttpApi.taskCreate")(function* (ctx: { payload: { prompt: string } }) {
      const workspace = yield* requireDesktopWorkspace()
      const session = yield* sessions.create({ title: "Desktop task" })
      const task: Task = { taskId: session.id, sessionID: session.id, workspace, status: "running" }
      tasks.set(task.taskId, task)
      latestTask = task

      const run = prompts.prompt({ sessionID: session.id, parts: [{ type: "text", text: ctx.payload.prompt }] }).pipe(
        Effect.tap(() => Effect.sync(() => task.status === "running" && (task.status = "complete"))),
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (task.status === "cancelled") return
            task.status = "failed"
            // Do not expose provider messages, prompts, stack traces, or credentials.
            task.error = "Task failed"
          }),
        ),
      )
      task.fiber = yield* Effect.forkIn(run, scope)
      return publicTask(task)
    })

    const getTask = Effect.fn("DesktopHttpApi.taskGet")(function* (ctx: { params: { id: string } }) {
      const workspace = yield* requireDesktopWorkspace()
      const task = tasks.get(ctx.params.id)
      if (!task || task.workspace !== workspace)
        return yield* new DesktopTaskNotFoundError({ message: "Desktop task not found" })
      if (task.status === "running") {
        const status = yield* statuses.get(task.sessionID)
        if (status.type === "idle" && task.fiber) {
          if (task.fiber.pollUnsafe()) task.status = "complete"
        }
      }
      return publicTask(task)
    })

    const cancel = Effect.fn("DesktopHttpApi.taskCancel")(function* (ctx: { params: { id: string } }) {
      const workspace = yield* requireDesktopWorkspace()
      const task = tasks.get(ctx.params.id)
      if (!task || task.workspace !== workspace)
        return yield* new DesktopTaskNotFoundError({ message: "Desktop task not found" })
      if (task.status === "running") {
        task.status = "cancelled"
        yield* prompts.cancel(task.sessionID)
        if (task.fiber) yield* Fiber.interrupt(task.fiber)
      }
      return publicTask(task)
    })

    return handlers
      .handle("desktopChanges", changes)
      .handle("desktopDiff", diff)
      .handle("desktopTaskCreate", create)
      .handle("desktopTaskGet", getTask)
      .handle("desktopTaskCancel", cancel)
  }),
)
