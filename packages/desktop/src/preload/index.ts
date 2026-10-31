import { contextBridge, ipcRenderer } from "electron"
import { installDesktopBridge } from "./bridge"

installDesktopBridge(contextBridge, {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
})
