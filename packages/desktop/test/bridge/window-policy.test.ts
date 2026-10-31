import { describe, expect, test } from "bun:test"
import { hardenedWindowPreferences, installWindowPolicy } from "../../src/main/window-policy"

describe("window policy", () => {
  test("uses hardened web preferences", () => {
    expect(hardenedWindowPreferences("/app/preload.js")).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: "/app/preload.js",
    })
  })

  test("denies windows, navigation, and permissions", () => {
    let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined
    let requestPermission:
      ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    let checkPermission: ((_contents: unknown, permission: string) => boolean) | undefined
    installWindowPolicy(
      {
        webContents: {
          setWindowOpenHandler: (handler) => (openHandler = handler),
          on: (_event, handler) => (navigateHandler = handler),
          session: {
            setPermissionRequestHandler: (handler) => (requestPermission = handler),
            setPermissionCheckHandler: (handler) => (checkPermission = handler),
          },
        },
      },
      "app://kothora/index.html",
    )

    expect(openHandler!({ url: "https://example.com" })).toEqual({ action: "deny" })
    let prevented = false
    navigateHandler!({ preventDefault: () => (prevented = true) }, "https://example.com")
    expect(prevented).toBe(true)
    let allowed = true
    requestPermission!(null, "camera", (value) => (allowed = value))
    expect(allowed).toBe(false)
    expect(checkPermission!(null, "notifications")).toBe(false)
  })
})
