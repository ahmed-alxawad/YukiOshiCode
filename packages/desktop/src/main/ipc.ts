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
  isMainFrame?: boolean
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

export function trustedRendererIdentifier(rendererUrl: string): string {
  const url = new URL(rendererUrl)
  if (url.protocol === "file:") {
    if (url.host !== "" || !url.pathname || url.pathname === "/") {
      throw new Error("Untrusted renderer origin")
    }
    return `file://${url.pathname}`
  }
  if (url.origin === "null") {
    if (!url.host) throw new Error("Untrusted renderer origin")
    return `${url.protocol}//${url.host}`
  }
  return url.origin
}

const assertTrustedRenderer = (event: IpcEvent, allowed: ReadonlySet<string>) => {
  if (event.isMainFrame === false) throw new Error("Untrusted renderer origin")
  let caller: string
  try {
    caller = trustedRendererIdentifier(event.senderFrame.url)
  } catch {
    throw new Error("Untrusted renderer origin")
  }
  for (const entry of allowed) {
    try {
      if (trustedRendererIdentifier(entry) === caller) return
    } catch {
      // Ignore malformed or wildcard entries such as bare "file://".
    }
  }
  throw new Error("Untrusted renderer origin")
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
