import { app, BrowserWindow } from "electron"
import { resolve } from "node:path"
import { AgentCoreClient } from "./agent-client"
import { createUpdateController } from "./updater"
import { electronIpcRegistry, electronWorkspacePicker, nodeWorkspaceFileSystem } from "./electron-adapters"
import { registerDesktopIpc } from "./ipc"
import { installWindowPolicy, hardenedWindowPreferences } from "./window-policy"
import { WorkspaceService } from "./workspace"

const runtimeDir = typeof __dirname === "string" ? __dirname : process.resourcesPath
const rendererUrl = process.env.KOTHORA_RENDERER_URL ?? `file://${resolve(runtimeDir, "../renderer/index.html")}`
const agentUrl = process.env.KOTHORA_AGENT_URL ?? "http://127.0.0.1:8765/"

const createWindow = () => {
  const window = new BrowserWindow({
    ...hardenedWindowPreferences(resolve(runtimeDir, "../preload/index.js")),
    width: 1280,
    height: 800,
    show: false,
  })
  installWindowPolicy(window, rendererUrl)
  void window.loadURL(rendererUrl)
  window.once("ready-to-show", () => window.show())
  return window
}

const boot = async () => {
  const workspace = new WorkspaceService(nodeWorkspaceFileSystem, electronWorkspacePicker)
  const agent = new AgentCoreClient(agentUrl, (url, init) => fetch(url, init))
  registerDesktopIpc(electronIpcRegistry, {
    workspace,
    agent,
    allowedRendererOrigins: new Set([new URL(rendererUrl).origin === "null" ? "file://" : new URL(rendererUrl).origin]),
  })
  createWindow()
  await createUpdateController().check().catch(() => undefined)
}

void app.whenReady().then(boot)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
