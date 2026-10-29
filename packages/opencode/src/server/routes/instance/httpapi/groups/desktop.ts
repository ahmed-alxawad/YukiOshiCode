import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const RelativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))(?!.*\0).+$/),
)

export const DesktopDiffQuery = Schema.Struct({
  path: Schema.optional(RelativePath),
  source: Schema.optional(Schema.Literals(["git", "session"])),
})

export const DesktopTaskPayload = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000), Schema.isPattern(/\S/)),
})

export const DesktopTask = Schema.Struct({
  taskId: Schema.String,
  status: Schema.Literals(["running", "complete", "failed", "cancelled"]),
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
})

export const DesktopChange = Schema.Struct({
  path: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
})

export const DesktopDiff = Schema.Struct({ diff: Schema.String })

export class DesktopWorkspaceError extends Schema.ErrorClass<DesktopWorkspaceError>("DesktopWorkspaceError")(
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class DesktopTaskNotFoundError extends Schema.ErrorClass<DesktopTaskNotFoundError>("DesktopTaskNotFoundError")(
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const DesktopPaths = {
  changes: "/desktop/changes",
  diff: "/desktop/diff",
  tasks: "/desktop/tasks",
  task: "/desktop/tasks/:id",
  cancel: "/desktop/tasks/:id/cancel",
} as const

export const DesktopApi = HttpApi.make("desktop").add(
  HttpApiGroup.make("desktop")
    .add(
      HttpApiEndpoint.get("desktopChanges", DesktopPaths.changes, {
        success: described(Schema.Array(DesktopChange), "Desktop workspace changes"),
        error: DesktopWorkspaceError,
      }),
      HttpApiEndpoint.get("desktopDiff", DesktopPaths.diff, {
        query: DesktopDiffQuery,
        success: described(DesktopDiff, "Desktop workspace diff"),
        error: DesktopWorkspaceError,
      }),
      HttpApiEndpoint.post("desktopTaskCreate", DesktopPaths.tasks, {
        payload: DesktopTaskPayload,
        success: DesktopTask,
        error: DesktopWorkspaceError,
      }),
      HttpApiEndpoint.get("desktopTaskGet", DesktopPaths.task, {
        params: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)) }),
        success: DesktopTask,
        error: [DesktopWorkspaceError, DesktopTaskNotFoundError],
      }),
      HttpApiEndpoint.post("desktopTaskCancel", DesktopPaths.cancel, {
        params: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)) }),
        success: DesktopTask,
        error: [DesktopWorkspaceError, DesktopTaskNotFoundError],
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "desktop", description: "Authenticated desktop bridge routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
