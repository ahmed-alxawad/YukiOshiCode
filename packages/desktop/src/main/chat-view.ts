import { isIP } from "node:net"

export interface ChatViewWebPreferences {
  contextIsolation: true
  sandbox: true
  nodeIntegration: false
}

export interface ExternalLinkDelegate {
  openExternal(url: string): Promise<void>
}

export interface ChatViewTarget {
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

export interface ChatViewPolicy {
  readonly url: string
  readonly webPreferences: ChatViewWebPreferences
  install(target: ChatViewTarget): void
}

const privateIpv4 = (hostname: string) => {
  const parts = hostname.split(".").map(Number)
  const [first, second] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  )
}

const privateIpv6 = (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89a-f]/.test(normalized) ||
    normalized.startsWith("ff")
  )
}

const assertPublicHttpsUrl = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Chat URL must be a valid public HTTPS URL")
  }
  const hostname = url.hostname.toLowerCase()
  const ipVersion = isIP(hostname.replace(/^\[|\]$/g, ""))
  const isPrivateIp = (ipVersion === 4 && privateIpv4(hostname)) || (ipVersion === 6 && privateIpv6(hostname))
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (!ipVersion && !hostname.includes(".")) ||
    isPrivateIp
  ) {
    throw new Error("Chat URL must be a valid public HTTPS URL")
  }
  return url
}

const parseSafeHttps = (value: string) => {
  try {
    return assertPublicHttpsUrl(value)
  } catch {
    return null
  }
}

export function createChatViewPolicy(configuredUrl: string, links: ExternalLinkDelegate): ChatViewPolicy {
  const chatUrl = assertPublicHttpsUrl(configuredUrl)
  const safelyOpen = (url: URL) => {
    void links.openExternal(url.toString()).catch(() => {})
  }

  return Object.freeze({
    url: chatUrl.toString(),
    webPreferences: Object.freeze({ contextIsolation: true, sandbox: true, nodeIntegration: false }),
    install(target: ChatViewTarget) {
      target.webContents.setWindowOpenHandler(({ url: destination }) => {
        const url = parseSafeHttps(destination)
        if (url !== null && url.origin !== chatUrl.origin) safelyOpen(url)
        return { action: "deny" }
      })
      target.webContents.on("will-navigate", (event, destination) => {
        const url = parseSafeHttps(destination)
        const isSameOrigin = url !== null && url.origin === chatUrl.origin
        if (isSameOrigin) return
        event.preventDefault()
        if (url !== null) safelyOpen(url)
      })
      target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      target.webContents.session.setPermissionCheckHandler(() => false)
    },
  })
}
