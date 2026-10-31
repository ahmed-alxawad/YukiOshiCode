import { autoUpdater } from "electron-updater"
import { isIP } from "node:net"

export interface UpdateController {
  check(): Promise<void>
}

export interface DesktopUpdater {
  setFeedURL(url: string): void
  checkForUpdates(): Promise<unknown>
}

const unsafeIpv4 = (hostname: string) => {
  const [first, second, third] = hostname.split(".").map(Number)
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  )
}

const unsafeIpv6 = (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89a-f]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  )
}

const publicFeedUrl = (configuredUrl: string | undefined) => {
  if (!configuredUrl || configuredUrl !== configuredUrl.trim() || /[\\\u0000-\u001f\u007f]/.test(configuredUrl)) {
    throw new Error("Auto-update feed URL must be an explicitly configured public HTTPS URL")
  }

  let url: URL
  try {
    url = new URL(configuredUrl)
  } catch {
    throw new Error("Auto-update feed URL must be an explicitly configured public HTTPS URL")
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  const bareHostname = hostname.replace(/^\[|\]$/g, "")
  const ipVersion = isIP(bareHostname)
  const privateIp = (ipVersion === 4 && unsafeIpv4(hostname)) || (ipVersion === 6 && unsafeIpv6(hostname))
  const encodedPathTrick = /%(?:2e|2f|5c)/i.test(configuredUrl)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (!ipVersion && !hostname.includes(".")) ||
    privateIp ||
    encodedPathTrick
  ) {
    throw new Error("Auto-update feed URL must be an explicitly configured public HTTPS URL without credentials")
  }
  return url.toString()
}

/** Updates are opt-in at runtime; no endpoint or credentials are bundled. */
export function createUpdateController(
  enabled = Boolean(process.env.KOTHORA_AUTO_UPDATE_URL),
  updater: DesktopUpdater = autoUpdater,
  configuredUrl = process.env.KOTHORA_AUTO_UPDATE_URL,
): UpdateController {
  const feedUrl = enabled ? publicFeedUrl(configuredUrl) : undefined
  return {
    async check() {
      if (!enabled) return
      updater.setFeedURL(feedUrl!)
      await updater.checkForUpdates()
    },
  }
}
