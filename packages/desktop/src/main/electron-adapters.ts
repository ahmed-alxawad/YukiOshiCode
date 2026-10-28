import { dialog, ipcMain } from "electron"
import { promises as fs } from "node:fs"
import type { DesktopChannel } from "./contracts"
import type { IpcRegistry } from "./ipc"
import type { WorkspaceFileSystem, WorkspacePicker } from "./workspace"

export const electronIpcRegistry: IpcRegistry = {
  handle(channel: DesktopChannel, handler) {
    ipcMain.handle(channel, (event, payload) => {
      if (event.senderFrame === null) throw new Error("Untrusted renderer origin")
      return handler({ senderFrame: { url: event.senderFrame.url } }, payload)
    })
  },
}

export const electronWorkspacePicker: WorkspacePicker = {
  async pickDirectory() {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  },
}

export const nodeWorkspaceFileSystem: WorkspaceFileSystem = {
  realpath: (value) => fs.realpath(value),
  readdir: (value) => fs.readdir(value, { withFileTypes: true }),
  readFile: (value, encoding) => fs.readFile(value, encoding),
}
