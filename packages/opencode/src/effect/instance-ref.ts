import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@yukioshi/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~yukioshi/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~yukioshi/WorkspaceRef", {
  defaultValue: () => undefined,
})
