declare global {
  const YUKIOSHI_VERSION: string
  const YUKIOSHI_CHANNEL: string
}

export const InstallationVersion = typeof YUKIOSHI_VERSION === "string" ? YUKIOSHI_VERSION : "local"
export const InstallationChannel = typeof YUKIOSHI_CHANNEL === "string" ? YUKIOSHI_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
