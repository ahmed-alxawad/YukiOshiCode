import { describe, expect, test } from "bun:test"
import { createChatViewPolicy } from "../../src/main/chat-view"

const setup = () => {
  const opened: string[] = []
  const policy = createChatViewPolicy("https://chat.kothora.example/app", {
    openExternal: async (url) => {
      opened.push(url)
    },
  })
  let openWindow: ((details: { url: string }) => { action: "deny" }) | undefined
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined
  let requestPermission:
    ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
  let checkPermission: ((_contents: unknown, permission: string) => boolean) | undefined
  policy.install({
    webContents: {
      setWindowOpenHandler: (handler) => (openWindow = handler),
      on: (_event, handler) => (navigate = handler),
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

  test("blocks and delegates external HTTPS navigation", async () => {
    const { navigate, opened } = setup()
    let prevented = false
    navigate({ preventDefault: () => (prevented = true) }, "https://support.example.com/bn")
    await Promise.resolve()
    expect(prevented).toBe(true)
    expect(opened).toEqual(["https://support.example.com/bn"])
  })

  test("denies new windows and delegates only external HTTPS links", async () => {
    const { openWindow, opened } = setup()
    expect(openWindow({ url: "https://docs.example.com/help" })).toEqual({ action: "deny" })
    expect(openWindow({ url: "http://docs.example.com/help" })).toEqual({ action: "deny" })
    expect(openWindow({ url: "https://chat.kothora.example/new" })).toEqual({ action: "deny" })
    await Promise.resolve()
    expect(opened).toEqual(["https://docs.example.com/help"])
  })

  test("denies every permission and uses hardened preferences", () => {
    const { policy, requestPermission, checkPermission } = setup()
    expect(policy.webPreferences).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false })
    let allowed = true
    requestPermission(null, "camera", (value) => (allowed = value))
    expect(allowed).toBe(false)
    expect(checkPermission(null, "geolocation")).toBe(false)
  })
})
