import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js"

/**
 * Environment variables that a local MCP server needs for ordinary process startup.
 * Keep this small: a configured server should not receive credentials by default.
 */
const BASE_ENV = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"])
const WINDOWS_BASE_ENV = new Set(["SYSTEMROOT", "PATHEXT", "COMSPEC", "USERPROFILE", "APPDATA"])
const PROXY_ENV_PATTERN = /^(?:ALL|FTP|GOPHER|HTTP|HTTPS|NO|SOCKS|WS|WSS)_PROXY$/i

export interface LocalConfig {
  readonly environment?: Readonly<Record<string, string>>
  readonly inherit_env?: boolean
}

function isSafeBaseVariable(name: string) {
  if (PROXY_ENV_PATTERN.test(name)) return true

  if (process.platform === "win32") {
    const normalized = name.toUpperCase()
    return BASE_ENV.has(normalized) || WINDOWS_BASE_ENV.has(normalized) || normalized.startsWith("LC_")
  }

  return BASE_ENV.has(name) || name.startsWith("LC_")
}

let defaultsRestricted = false

function restrictTransportDefaults() {
  if (defaultsRestricted) return

  // The SDK merges this list after our supplied environment. Keep its defaults
  // within the same allowlist so it cannot add LOGNAME, TEMP, or other values.
  const safeDefaults = DEFAULT_INHERITED_ENV_VARS.filter(isSafeBaseVariable)
  DEFAULT_INHERITED_ENV_VARS.splice(0, DEFAULT_INHERITED_ENV_VARS.length, ...safeDefaults)
  defaultsRestricted = true
}

/** Builds the environment for a local stdio MCP process. */
export function local(config: LocalConfig, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  restrictTransportDefaults()
  const environment: Record<string, string> = {}
  const inheritAll = config.inherit_env === true

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (inheritAll || isSafeBaseVariable(name)) environment[name] = value
  }

  return { ...environment, ...config.environment }
}

export * as McpEnvironment from "./environment"
