export interface CrashMetadata {
  appVersion: string
  platform: string
  arch: string
  errorName: string
}

export type CrashSender = (metadata: CrashMetadata) => Promise<void>
export type CrashFetch = (
  url: string,
  init: { method: "POST"; redirect: "error"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>

const safeErrorName = (error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError"
  const normalized = name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64)
  return normalized || "Error"
}

/** Builds deliberately content-free metadata: never messages, stacks, paths, code, or prompts. */
export function buildCrashMetadata(error: unknown, appVersion: string): CrashMetadata {
  return {
    appVersion: /^[0-9A-Za-z.+_-]{1,64}$/.test(appVersion) ? appVersion : "unknown",
    platform: process.platform,
    arch: process.arch,
    errorName: safeErrorName(error),
  }
}

/** Creates an anonymous, credential-free sender for a configured HTTPS collector. */
export function createCrashSender(endpoint: string, fetcher: CrashFetch): CrashSender {
  const url = new URL(endpoint)
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const version = isIP(host)
  const octets = version === 4 ? host.split(".").map(Number) : []
  const privateIp =
    (version === 4 &&
      (octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        octets[0]! >= 224)) ||
    (version === 6 &&
      (host === "::" ||
        host === "::1" ||
        host.startsWith("::ffff:") ||
        host.startsWith("fc") ||
        host.startsWith("fd") ||
        /^fe[89a-f]/.test(host) ||
        host.startsWith("ff")))
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!version && !host.includes(".")) ||
    privateIp
  ) {
    throw new Error("Crash report URL must be public HTTPS")
  }
  return async (metadata) => {
    const response = await fetcher(url.toString(), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata),
    })
    if (!response.ok) throw new Error("Crash collector rejected report")
  }
}

/** Installs a minimal crash hook. It never includes source, prompts, or workspace paths. */
export function installCrashReporting(sender: CrashSender | undefined, appVersion: string): void {
  if (!sender) return
  const report = (error: unknown) => {
    void sender(buildCrashMetadata(error, appVersion)).catch(() => undefined)
  }
  // Monitor preserves Node's default fatal behavior for uncaught exceptions.
  process.on("uncaughtExceptionMonitor", report)
  process.on("unhandledRejection", report)
}
import { isIP } from "node:net"
