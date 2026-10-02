export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Process } from "@/util/process"

const MANAGED_PLIST_DOMAINS = ["com.yukioshi.managed", "ai.opencode.managed"]

// Keys injected by macOS/MDM into the managed plist that are not YukiOshi config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

export function systemManagedConfigDirs(
  platform: NodeJS.Platform = process.platform,
  programData = process.env.ProgramData || "C:\\ProgramData",
): string[] {
  switch (platform) {
    case "darwin":
      return ["/Library/Application Support/opencode", "/Library/Application Support/yukioshi"]
    case "win32":
      return [path.join(programData, "opencode"), path.join(programData, "yukioshi")]
    default:
      return ["/etc/opencode", "/etc/yukioshi"]
  }
}

export function managedConfigDirs() {
  const test = process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR
  return test ? [test] : systemManagedConfigDirs()
}

export function managedConfigDir() {
  return managedConfigDirs().at(-1)!
}

export function managedPreferencePaths(user: string) {
  return MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ])
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const paths = managedPreferencePaths(user)

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) continue
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
