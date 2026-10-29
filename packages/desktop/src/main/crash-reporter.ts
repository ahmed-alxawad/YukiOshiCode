export interface CrashMetadata {
  appVersion: string
  platform: string
  arch: string
  errorName: string
  errorMessage: string
}

export type CrashSender = (metadata: CrashMetadata) => Promise<void>

/** Installs a minimal crash hook. It never includes source, prompts, or workspace paths. */
export function installCrashReporting(sender?: CrashSender): void {
  if (!sender) return
  const report = (error: unknown) => {
    const value = error instanceof Error ? error : new Error(String(error))
    void sender({
      appVersion: process.env.npm_package_version ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      errorName: value.name.slice(0, 128),
      errorMessage: value.message.slice(0, 512),
    }).catch(() => undefined)
  }
  process.on("uncaughtException", report)
  process.on("unhandledRejection", report)
}
