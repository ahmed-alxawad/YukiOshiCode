import { desktopChannels, type DesktopChannel } from "./contracts"
import type { ManagedAgent } from "./managed-agent"
import type { WorkspaceService } from "./workspace"
import {
  validateCancelTask,
  validateGetTask,
  validateNoPayload,
  validateReadDiff,
  validateRelativePath,
  validateStartTask,
} from "./validation"

export interface IpcEvent {
  senderFrame: { url: string }
}

export type IpcHandler = (event: IpcEvent, payload?: unknown) => Promise<unknown>

export interface IpcRegistry {
  handle(channel: DesktopChannel, handler: IpcHandler): void
}

export interface IpcDependencies {
  workspace: WorkspaceService
  agent: ManagedAgent
  allowedRendererOrigins: ReadonlySet<string>
}

const assertTrustedRenderer = (event: IpcEvent, allowed: ReadonlySet<string>) => {
  let origin: string
  try {
    const url = new URL(event.senderFrame.url)
    origin = url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    throw new Error("Untrusted renderer origin")
  }
  if (!allowed.has(origin)) throw new Error("Untrusted renderer origin")
}

export function registerDesktopIpc(registry: IpcRegistry, dependencies: IpcDependencies): void {
  const register = (channel: DesktopChannel, handler: (payload: unknown) => Promise<unknown>) => {
    registry.handle(channel, async (event, payload) => {
      assertTrustedRenderer(event, dependencies.allowedRendererOrigins)
      return handler(payload)
    })
  }

  register(desktopChannels.selectWorkspace, async (payload) => {
    validateNoPayload(payload)
    const selected = await dependencies.workspace.select()
    if (selected) await dependencies.agent.selectWorkspace(selected.path)
    return selected
  })
  register(desktopChannels.listWorkspaceFiles, async (payload) => {
    validateNoPayload(payload)
    return dependencies.workspace.listFiles()
  })
  register(desktopChannels.readWorkspaceFile, async (payload) =>
    dependencies.workspace.readFile(validateRelativePath(payload)),
  )
  register(desktopChannels.listChanges, async (payload) => {
    validateNoPayload(payload)
    return dependencies.agent.listChanges()
  })
  register(desktopChannels.readDiff, async (payload) => dependencies.agent.readDiff(validateReadDiff(payload)))
  register(desktopChannels.startTask, async (payload) => dependencies.agent.startTask(validateStartTask(payload)))
  register(desktopChannels.getTask, async (payload) => dependencies.agent.getTask(validateGetTask(payload)))
  register(desktopChannels.cancelTask, async (payload) => dependencies.agent.cancelTask(validateCancelTask(payload)))
}
