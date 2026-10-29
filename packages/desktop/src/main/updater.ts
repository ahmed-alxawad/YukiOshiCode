import { autoUpdater } from "electron-updater"

export interface UpdateController {
  check(): Promise<void>
}

/** Updates are opt-in at runtime; no endpoint or credentials are bundled. */
export function createUpdateController(enabled = Boolean(process.env.KOTHORA_AUTO_UPDATE_URL)): UpdateController {
  return {
    async check() {
      if (!enabled) return
      await autoUpdater.checkForUpdates()
    },
  }
}
