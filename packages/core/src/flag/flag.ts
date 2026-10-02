import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["YUKIOSHI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["YUKIOSHI_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("YUKIOSHI_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  YUKIOSHI_AUTO_HEAP_SNAPSHOT: truthy("YUKIOSHI_AUTO_HEAP_SNAPSHOT"),
  YUKIOSHI_GIT_BASH_PATH: process.env["YUKIOSHI_GIT_BASH_PATH"],
  YUKIOSHI_CONFIG: process.env["YUKIOSHI_CONFIG"],
  YUKIOSHI_CONFIG_CONTENT: process.env["YUKIOSHI_CONFIG_CONTENT"],
  YUKIOSHI_DISABLE_AUTOUPDATE: truthy("YUKIOSHI_DISABLE_AUTOUPDATE"),
  YUKIOSHI_ALWAYS_NOTIFY_UPDATE: truthy("YUKIOSHI_ALWAYS_NOTIFY_UPDATE"),
  YUKIOSHI_DISABLE_PRUNE: truthy("YUKIOSHI_DISABLE_PRUNE"),
  YUKIOSHI_DISABLE_TERMINAL_TITLE: truthy("YUKIOSHI_DISABLE_TERMINAL_TITLE"),
  YUKIOSHI_SHOW_TTFD: truthy("YUKIOSHI_SHOW_TTFD"),
  YUKIOSHI_DISABLE_AUTOCOMPACT: truthy("YUKIOSHI_DISABLE_AUTOCOMPACT"),
  YUKIOSHI_DISABLE_MODELS_FETCH: truthy("YUKIOSHI_DISABLE_MODELS_FETCH"),
  YUKIOSHI_DISABLE_MOUSE: truthy("YUKIOSHI_DISABLE_MOUSE"),
  YUKIOSHI_FAKE_VCS: process.env["YUKIOSHI_FAKE_VCS"],
  YUKIOSHI_SERVER_PASSWORD: process.env["YUKIOSHI_SERVER_PASSWORD"],
  YUKIOSHI_SERVER_USERNAME: process.env["YUKIOSHI_SERVER_USERNAME"],
  YUKIOSHI_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("YUKIOSHI_DISABLE_FFF"),

  // Experimental
  YUKIOSHI_EXPERIMENTAL_FILEWATCHER: Config.boolean("YUKIOSHI_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  YUKIOSHI_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("YUKIOSHI_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  YUKIOSHI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("YUKIOSHI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  YUKIOSHI_MODELS_URL: process.env["YUKIOSHI_MODELS_URL"],
  YUKIOSHI_MODELS_PATH: process.env["YUKIOSHI_MODELS_PATH"],
  YUKIOSHI_DB: process.env["YUKIOSHI_DB"],

  YUKIOSHI_WORKSPACE_ID: process.env["YUKIOSHI_WORKSPACE_ID"],
  YUKIOSHI_EXPERIMENTAL_WORKSPACES: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get YUKIOSHI_DISABLE_PROJECT_CONFIG() {
    return truthy("YUKIOSHI_DISABLE_PROJECT_CONFIG")
  },
  get YUKIOSHI_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("YUKIOSHI_EXPERIMENTAL_REFERENCES")
  },
  get YUKIOSHI_TUI_CONFIG() {
    return process.env["YUKIOSHI_TUI_CONFIG"]
  },
  get YUKIOSHI_CONFIG_DIR() {
    return process.env["YUKIOSHI_CONFIG_DIR"]
  },
  get YUKIOSHI_PURE() {
    return truthy("YUKIOSHI_PURE")
  },
  get YUKIOSHI_PERMISSION() {
    return process.env["YUKIOSHI_PERMISSION"]
  },
  get YUKIOSHI_PLUGIN_META_FILE() {
    return process.env["YUKIOSHI_PLUGIN_META_FILE"]
  },
  get YUKIOSHI_CLIENT() {
    return process.env["YUKIOSHI_CLIENT"] ?? "cli"
  },
}
