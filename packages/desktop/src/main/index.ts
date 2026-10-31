import { app, BrowserWindow, Menu, shell, WebContentsView, type MenuItemConstructorOptions } from "electron"
import { resolve } from "node:path"
import { ManagedAgent } from "./managed-agent"
import { createChatViewPolicy } from "./chat-view"
import { createCrashSender, installCrashReporting } from "./crash-reporter"
import { createUpdateController } from "./updater"
import { electronIpcRegistry, electronWorkspacePicker, nodeWorkspaceFileSystem } from "./electron-adapters"
import { registerDesktopIpc } from "./ipc"
import { installWindowPolicy, hardenedWindowPreferences } from "./window-policy"
import { WorkspaceService } from "./workspace"

const runtimeDir = typeof __dirname === "string" ? __dirname : process.resourcesPath
const rendererUrl = process.env.KOTHORA_RENDERER_URL ?? `file://${resolve(runtimeDir, "../renderer/index.html")}`
const agentExecutable =
  process.env.KOTHORA_AGENT_EXECUTABLE ??
  resolve(process.resourcesPath ?? runtimeDir, "agent", process.platform === "win32" ? "yukioshi.exe" : "yukioshi")

const crashReportUrl = process.env.KOTHORA_CRASH_REPORT_URL
if (crashReportUrl) {
  try {
    installCrashReporting(
      createCrashSender(crashReportUrl, (url, init) => fetch(url, init)),
      app.getVersion(),
    )
  } catch {
    // An invalid optional collector must never prevent the local Code area from starting.
  }
}

export interface AreaController {
  readonly chatAvailable: boolean
  showChat(): void
  showCode(): void
  dispose(): void
}

interface ChatHostWindow {
  contentView: {
    addChildView(view: WebContentsView): void
    removeChildView(view: WebContentsView): void
  }
  getContentBounds(): { width: number; height: number }
  on(event: "resize" | "closed", listener: () => void): unknown
  off(event: "resize", listener: () => void): unknown
}

type ChatViewFactory = (options: Electron.WebContentsViewConstructorOptions) => WebContentsView

const codeOnlyController = (): AreaController => ({
  chatAvailable: false,
  showChat() {},
  showCode() {},
  dispose() {},
})

export function createChatArea(
  window: ChatHostWindow,
  configuredUrl: string | undefined,
  configuredAuthOrigins?: string,
  createView: ChatViewFactory = (options) => new WebContentsView(options),
  openExternal: (url: string) => Promise<unknown> = (url) => shell.openExternal(url),
): AreaController {
  if (!configuredUrl) return codeOnlyController()

  let policy
  try {
    policy = createChatViewPolicy(
      configuredUrl,
      { openExternal: async (url) => void (await openExternal(url)) },
      configuredAuthOrigins,
    )
  } catch {
    return codeOnlyController()
  }

  const view = createView({
    webPreferences: policy.webPreferences,
  })
  policy.install(view)
  view.setVisible(false)
  window.contentView.addChildView(view)

  const resize = () => {
    const { width, height } = window.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  const dispose = () => {
    window.off("resize", resize)
    window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  window.on("resize", resize)
  window.on("closed", dispose)
  resize()
  void view.webContents.loadURL(policy.url).catch(() => undefined)

  return {
    chatAvailable: true,
    showChat: () => view.setVisible(true),
    showCode: () => view.setVisible(false),
    dispose,
  }
}

export function installAreaMenu(controller: AreaController): void {
  const areaItems: MenuItemConstructorOptions[] = [
    { label: "Code / কোড", accelerator: "CmdOrCtrl+1", click: () => controller.showCode() },
  ]
  if (controller.chatAvailable) {
    areaItems.push({ label: "Chat / চ্যাট", accelerator: "CmdOrCtrl+2", click: () => controller.showChat() })
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Kothora / কথোরা", submenu: [{ role: "quit" }] },
      { label: "Area / অংশ", submenu: areaItems },
      {
        label: "Edit / সম্পাদনা",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
    ]),
  )
}

const createWindow = () => {
  const window = new BrowserWindow({
    ...hardenedWindowPreferences(resolve(runtimeDir, "../preload/index.js")),
    width: 1280,
    height: 800,
    show: false,
  })
  installWindowPolicy(window, rendererUrl)
  const areas = createChatArea(window, process.env.KOTHORA_WEB_URL, process.env.KOTHORA_AUTH_ORIGINS)
  installAreaMenu(areas)
  void window.loadURL(rendererUrl)
  window.once("ready-to-show", () => window.show())
  return window
}

const boot = async () => {
  const workspace = new WorkspaceService(nodeWorkspaceFileSystem, electronWorkspacePicker)
  const agent = new ManagedAgent(agentExecutable, (url, init) => fetch(url, init))
  app.once("before-quit", () => agent.dispose())
  registerDesktopIpc(electronIpcRegistry, {
    workspace,
    agent,
    allowedRendererOrigins: new Set([new URL(rendererUrl).origin === "null" ? "file://" : new URL(rendererUrl).origin]),
  })
  createWindow()
  try {
    await createUpdateController().check()
  } catch {
    // An invalid or unavailable optional feed must not prevent local Code use.
  }
}

void app.whenReady().then(boot)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
