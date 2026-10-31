import { describe, expect, test } from "bun:test"
import { createChatViewPolicy, type ChatViewTarget, type WindowOpenResult } from "../../src/main/chat-view"

const setup = (authOrigins?: string) => {
  const opened: string[] = []
  const policy = createChatViewPolicy(
    "https://chat.kothora.example/app",
    { openExternal: async (url) => void opened.push(url) },
    authOrigins,
  )
  let openWindow: ((details: { url: string }) => WindowOpenResult) | undefined
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined
  let didCreateWindow: ((window: ChatViewTarget, details: { url: string }) => void) | undefined
  let requestPermission:
    ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
  let checkPermission: ((_contents: unknown, permission: string) => boolean) | undefined
  policy.install({
    webContents: {
      setWindowOpenHandler: (handler) => (openWindow = handler),
      on: (event, handler) => {
        if (event === "will-navigate") {
          navigate = handler as (event: { preventDefault(): void }, url: string) => void
        } else {
          didCreateWindow = handler as (window: ChatViewTarget, details: { url: string }) => void
        }
      },
      session: {
        setPermissionRequestHandler: (handler) => (requestPermission = handler),
        setPermissionCheckHandler: (handler) => (checkPermission = handler),
      },
    },
  })
  return {
    policy,
    opened,
    openWindow: openWindow!,
    navigate: navigate!,
    didCreateWindow: didCreateWindow!,
    requestPermission: requestPermission!,
    checkPermission: checkPermission!,
  }
}

describe("Chat view policy", () => {
  test("requires a configured public HTTPS URL", () => {
    const links = { openExternal: async () => {} }
    for (const url of [
      "http://chat.example.com",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://192.168.1.2",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://service.internal",
      "https://user:secret@example.com",
      "not a URL",
    ]) {
      expect(() => createChatViewPolicy(url, links)).toThrow("public HTTPS")
    }
  })

  test("rejects malformed or private auth-origin configuration", () => {
    const links = { openExternal: async () => {} }
    for (const origins of [
      "https://accounts.example.com/path",
      "http://accounts.example.com",
      "https://127.0.0.1",
      "https://accounts.example.com,,https://login.example.org",
    ]) {
      expect(() => createChatViewPolicy("https://chat.kothora.example", links, origins)).toThrow()
    }
  })

  test("allows same-origin navigation", () => {
    const { navigate } = setup()
    let prevented = false
    navigate({ preventDefault: () => (prevented = true) }, "https://chat.kothora.example/conversations/123?lang=bn")
    expect(prevented).toBe(false)
  })

  test("blocks hostile navigation without delegating unsafe schemes", async () => {
    const { navigate, opened } = setup()
    for (const destination of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,bad", "not a URL"]) {
      let prevented = false
      navigate({ preventDefault: () => (prevented = true) }, destination)
      expect(prevented).toBe(true)
    }
    await Promise.resolve()
    expect(opened).toEqual([])
  })

  test("blocks and delegates unlisted external HTTPS navigation", async () => {
    const { navigate, opened } = setup("https://accounts.example.com")
    let prevented = false
    navigate({ preventDefault: () => (prevented = true) }, "https://support.example.com/bn")
    await Promise.resolve()
    expect(prevented).toBe(true)
    expect(opened).toEqual(["https://support.example.com/bn"])
  })

  test("denies unlisted windows and delegates only external HTTPS links", async () => {
    const { openWindow, opened } = setup()
    expect(openWindow({ url: "https://docs.example.com/help" })).toEqual({ action: "deny" })
    expect(openWindow({ url: "http://docs.example.com/help" })).toEqual({ action: "deny" })
    expect(openWindow({ url: "https://chat.kothora.example/new" })).toMatchObject({ action: "allow" })
    await Promise.resolve()
    expect(opened).toEqual(["https://docs.example.com/help"])
  })

  test("allows configured OAuth navigation and hardened popups that can return to Chat", () => {
    const { openWindow, navigate, didCreateWindow } = setup("https://accounts.example.com, https://login.example.org")
    let prevented = false
    navigate({ preventDefault: () => (prevented = true) }, "https://accounts.example.com/oauth/authorize")
    expect(prevented).toBe(false)

    const popupResult = openWindow({ url: "https://accounts.example.com/oauth/authorize" })
    expect(popupResult).toEqual({
      action: "allow",
      overrideBrowserWindowOptions: {
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          partition: "persist:kothora-chat",
        },
      },
    })
    expect(
      "preload" in
        (popupResult as { overrideBrowserWindowOptions: { webPreferences: object } }).overrideBrowserWindowOptions
          .webPreferences,
    ).toBe(false)

    let popupNavigate: ((event: { preventDefault(): void }, url: string) => void) | undefined
    let popupPermission:
      ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    didCreateWindow(
      {
        webContents: {
          setWindowOpenHandler: () => {},
          on: (event, handler) => {
            if (event === "will-navigate") {
              popupNavigate = handler as (event: { preventDefault(): void }, url: string) => void
            }
          },
          session: {
            setPermissionRequestHandler: (handler) => (popupPermission = handler),
            setPermissionCheckHandler: () => {},
          },
        },
      },
      { url: "https://accounts.example.com/oauth/authorize" },
    )
    let returnPrevented = false
    popupNavigate!({ preventDefault: () => (returnPrevented = true) }, "https://chat.kothora.example/auth/callback")
    expect(returnPrevented).toBe(false)
    let permissionAllowed = true
    popupPermission!(null, "camera", (allowed) => (permissionAllowed = allowed))
    expect(permissionAllowed).toBe(false)
  })

  test("denies every permission and uses hardened preferences", () => {
    const { policy, requestPermission, checkPermission } = setup()
    expect(policy.webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: "persist:kothora-chat",
    })
    let allowed = true
    requestPermission(null, "camera", (value) => (allowed = value))
    expect(allowed).toBe(false)
    expect(checkPermission(null, "geolocation")).toBe(false)
  })
})
