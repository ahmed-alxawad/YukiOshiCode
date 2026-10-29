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
export function buildCrashMetadata(error: unknown): CrashMetadata {
  return {
    appVersion: process.env.npm_package_version ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    errorName: safeErrorName(error),
  }
}

/** Creates an anonymous, credential-free sender for a configured HTTPS collector. */
export function createCrashSender(endpoint: string, fetcher: CrashFetch): CrashSender {
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
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
export function installCrashReporting(sender?: CrashSender): void {
  if (!sender) return
  const report = (error: unknown) => {
    void sender(buildCrashMetadata(error)).catch(() => undefined)
  }
  process.on("uncaughtException", report)
  process.on("unhandledRejection", report)
}
