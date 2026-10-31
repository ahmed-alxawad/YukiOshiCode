export interface WindowPreferences {
  contextIsolation: boolean
  sandbox: boolean
  nodeIntegration: boolean
  preload: string
}

export interface WindowPolicyTarget {
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void
    on(event: "will-navigate", handler: (event: { preventDefault(): void }, url: string) => void): void
    session: {
      setPermissionRequestHandler(
        handler: (_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
      ): void
      setPermissionCheckHandler(handler: (_contents: unknown, permission: string) => boolean): void
    }
  }
}

export function hardenedWindowPreferences(preload: string): WindowPreferences {
  return { contextIsolation: true, sandbox: true, nodeIntegration: false, preload }
}

export function installWindowPolicy(window: WindowPolicyTarget, rendererUrl: string): void {
  const trustedUrl = new URL(rendererUrl)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, destination) => {
    let allowed = false
    try {
      const next = new URL(destination)
      allowed =
        next.protocol === trustedUrl.protocol &&
        next.host === trustedUrl.host &&
        next.pathname === trustedUrl.pathname &&
        next.username === "" &&
        next.password === ""
    } catch {}
    if (!allowed) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
}
