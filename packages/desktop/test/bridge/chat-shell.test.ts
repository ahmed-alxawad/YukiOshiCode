import { describe, expect, mock, test } from "bun:test"

const pending = new Promise<void>(() => {})
mock.module("electron", () => ({
  app: { whenReady: () => pending, on: () => {}, quit: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
  WebContentsView: class {},
  shell: { openExternal: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => {} },
}))
mock.module("electron-updater", () => ({ autoUpdater: { checkForUpdates: async () => {} } }))

const { createChatArea } = await import("../../src/main/index")

const createHost = () => {
  const listeners = new Map<string, () => void>()
  const added: unknown[] = []
  const removed: unknown[] = []
  const host = {
    contentView: {
      addChildView: (view: unknown) => added.push(view),
      removeChildView: (view: unknown) => removed.push(view),
    },
    getContentBounds: () => ({ width: 1200, height: 720 }),
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
  }
  return { host, listeners, added, removed }
}

describe("Chat and Code shell", () => {
  test("keeps Code usable when Chat configuration is absent or invalid", () => {
    const { host, added } = createHost()
    expect(createChatArea(host as never, undefined).chatAvailable).toBe(false)
    expect(createChatArea(host as never, "http://private.invalid").chatAvailable).toBe(false)
    expect(added).toEqual([])
  })

  test("creates an isolated remote view and handles switching, resize, and close", async () => {
    const { host, listeners, added, removed } = createHost()
    const visibility: boolean[] = []
    const bounds: unknown[] = []
    const loaded: string[] = []
    let closed = false
    let options: Electron.WebContentsViewConstructorOptions | undefined
    const view = {
      setVisible: (visible: boolean) => visibility.push(visible),
      setBounds: (value: unknown) => bounds.push(value),
      webContents: {
        setWindowOpenHandler: () => {},
        on: () => {},
        session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
        loadURL: async (url: string) => void loaded.push(url),
        isDestroyed: () => false,
        close: () => (closed = true),
      },
    }
    const controller = createChatArea(host as never, "https://chat.kothora.example/app", (value) => {
      options = value
      return view as never
    })
    await Promise.resolve()

    expect(controller.chatAvailable).toBe(true)
    expect(options?.webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: "persist:kothora-chat",
    })
    expect("preload" in (options?.webPreferences ?? {})).toBe(false)
    expect(added).toEqual([view])
    expect(loaded).toEqual(["https://chat.kothora.example/app"])
    expect(bounds).toEqual([{ x: 0, y: 0, width: 1200, height: 720 }])

    controller.showChat()
    controller.showCode()
    expect(visibility).toEqual([false, true, false])
    listeners.get("resize")?.()
    expect(bounds).toHaveLength(2)
    listeners.get("closed")?.()
    expect(removed).toEqual([view])
    expect(closed).toBe(true)
  })
})
