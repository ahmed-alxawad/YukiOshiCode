import { desktopChannels, type DesktopBridge } from "../main/contracts"

export interface IpcInvoker {
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

export interface ContextBridgeAdapter {
  exposeInMainWorld(name: string, api: DesktopBridge): void
}

export function createDesktopBridge(ipc: IpcInvoker): DesktopBridge {
  const bridge: DesktopBridge = {
    selectWorkspace: () => ipc.invoke(desktopChannels.selectWorkspace) as ReturnType<DesktopBridge["selectWorkspace"]>,
    listWorkspaceFiles: () =>
      ipc.invoke(desktopChannels.listWorkspaceFiles) as ReturnType<DesktopBridge["listWorkspaceFiles"]>,
    readWorkspaceFile: (path) =>
      ipc.invoke(desktopChannels.readWorkspaceFile, { path }) as ReturnType<DesktopBridge["readWorkspaceFile"]>,
    listChanges: () => ipc.invoke(desktopChannels.listChanges) as ReturnType<DesktopBridge["listChanges"]>,
    readDiff: (input) => ipc.invoke(desktopChannels.readDiff, input) as ReturnType<DesktopBridge["readDiff"]>,
    startTask: (input) => ipc.invoke(desktopChannels.startTask, input) as ReturnType<DesktopBridge["startTask"]>,
    cancelTask: (input) => ipc.invoke(desktopChannels.cancelTask, input) as ReturnType<DesktopBridge["cancelTask"]>,
  }
  return Object.freeze(bridge)
}

export function installDesktopBridge(contextBridge: ContextBridgeAdapter, ipc: IpcInvoker): void {
  contextBridge.exposeInMainWorld("kothoraDesktop", createDesktopBridge(ipc))
}
