import { Redact } from "@yukioshi/core/redact"
import { NamedError } from "@yukioshi/core/util/error"
import { errorFormat, errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"

type ConfigIssue = { message: string; path: string[] }

function isTaggedError(error: unknown, tag: string): error is Record<string, unknown> {
  return isRecord(error) && error._tag === tag
}

function configData(input: unknown, tag: string): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
  return undefined
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined
}

function configIssues(input: Record<string, unknown>): ConfigIssue[] {
  return Array.isArray(input.issues)
    ? input.issues.filter((issue): issue is ConfigIssue => {
        if (!isRecord(issue)) return false
        return (
          typeof issue.message === "string" &&
          Array.isArray(issue.path) &&
          issue.path.every((x) => typeof x === "string")
        )
      })
    : []
}

export function FormatError(input: unknown): string | undefined {
  const text = formatError(input)
  return text === undefined ? undefined : Redact.scrubKnown(Redact.mask(text))
}

function formatError(input: unknown): string | undefined {
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = formatError(input.cause.body)
    if (formatted) return formatted
  }

  // CliError: domain failure surfaced from an effectCmd handler via fail("...")
  if (isTaggedError(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return stringField(input, "message") ?? ""
  }

  // MCPFailed: { name: string }
  if (NamedError.hasName(input, "MCPFailed")) {
    const data = isRecord(input) && isRecord(input.data) ? stringField(input.data, "name") : undefined
    return `MCP server "${data}" failed. Note, YukiOshi does not support MCP authentication yet.`
  }

  // AccountServiceError, AccountTransportError: TaggedErrorClass
  if (isTaggedError(input, "AccountServiceError") || isTaggedError(input, "AccountTransportError")) {
    return stringField(input, "message") ?? ""
  }

  // ProviderModelNotFoundError: { providerID: string, modelID: string, suggestions?: string[] }
  const providerModelNotFound = configData(input, "ProviderModelNotFoundError")
  if (providerModelNotFound) {
    const suggestions = Array.isArray(providerModelNotFound.suggestions)
      ? providerModelNotFound.suggestions.filter((x) => typeof x === "string")
      : []
    return [
      `Model not found: ${stringField(providerModelNotFound, "providerID")}/${stringField(providerModelNotFound, "modelID")}`,
      ...(suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      `Try: \`yukioshi models\` to list available models`,
      `Or check your config (yukioshi.json or legacy opencode.json) provider/model names`,
    ].join("\n")
  }

  // ProviderInitError: { providerID: string }
  const providerInit = configData(input, "ProviderInitError")
  if (providerInit) {
    return `Failed to initialize provider "${stringField(providerInit, "providerID")}". Check credentials and configuration.`
  }

  // ConfigJsonError: { path: string, message?: string }
  const configJson = configData(input, "ConfigJsonError")
  if (configJson) {
    const message = stringField(configJson, "message")
    const errors = message?.includes("--- Errors ---")
      ? message
          .slice(message.indexOf("--- Errors ---") + "--- Errors ---".length)
          .split("--- End ---")[0]!
          .trim()
      : message
    return [
      `Config file at ${stringField(configJson, "path")} is not valid JSON(C)` + (errors ? `: ${errors}` : ""),
      "Fix the syntax in that file (a missing comma, quote or bracket is the usual cause), then run the command again.",
    ].join("\n")
  }

  // ConfigDirectoryTypoError: { dir: string, path: string, suggestion: string }
  const configDirectoryTypo = configData(input, "ConfigDirectoryTypoError")
  if (configDirectoryTypo) {
    return `Directory "${stringField(configDirectoryTypo, "dir")}" in ${stringField(configDirectoryTypo, "path")} is not valid. Rename the directory to "${stringField(configDirectoryTypo, "suggestion")}" or remove it. This is a common typo.`
  }

  // ConfigFrontmatterError: { message: string }
  const configFrontmatter = configData(input, "ConfigFrontmatterError")
  if (configFrontmatter) {
    return stringField(configFrontmatter, "message") ?? ""
  }

  // ConfigRemoteAuthError: { url: string, remote: string }
  const remoteAuth = configData(input, "ConfigRemoteAuthError")
  if (remoteAuth) {
    const url = stringField(remoteAuth, "url")
    const remote = stringField(remoteAuth, "remote")
    return [
      `Failed to load remote config${remote ? ` from ${remote}` : ""}: the server returned a login page instead of JSON.`,
      `Authentication is missing or has expired (the endpoint is likely behind an SSO or identity-aware proxy).`,
      ...(url ? [`Run \`yukioshi auth login ${url}\` to re-authenticate.`] : []),
    ].join("\n")
  }

  // ConfigInvalidError: { path?: string, message?: string, issues?: Array<{ message: string, path: string[] }> }
  const configInvalid = configData(input, "ConfigInvalidError")
  if (configInvalid) {
    const path = stringField(configInvalid, "path")
    const message = stringField(configInvalid, "message")
    const issues = configIssues(configInvalid)
    return [
      `Configuration is invalid${path && path !== "config" ? ` at ${path}` : ""}` + (message ? `: ${message}` : ""),
      ...issues.map((issue) => "↳ " + (issue.path.length ? issue.path.join(".") + ": " : "") + issue.message),
      ...(issues.length || message
        ? [
            `Fix the key${issues.length === 1 ? "" : "s"} above${path && path !== "config" ? ` in ${path}` : ""}, then run the command again. \`yukioshi debug config\` shows the settings YukiOshi reads.`,
          ]
        : []),
    ].join("\n")
  }

  // UICancelledError: user cancelled an interactive CLI prompt
  if (isTaggedError(input, "UICancelledError") || NamedError.hasName(input, "UICancelledError")) {
    return ""
  }

  // UnknownError: { message: string } - the server's plain error; show the sentence, not the JSON.
  if (NamedError.hasName(input, "UnknownError") && isRecord(input) && isRecord(input.data)) {
    const message = stringField(input.data, "message")
    if (message) return message
  }
  return undefined
}

export function FormatUnknownError(input: unknown): string {
  return errorFormat(input)
}

/** True when the user asked for debug output on the command line (`--log-level DEBUG`). */
export function debugRequested(argv: readonly string[]) {
  return argv.some((arg, i) => arg === "--log-level=DEBUG" || (arg === "--log-level" && argv[i + 1] === "DEBUG"))
}

/**
 * Text for an error nothing recognised. It names what failed in plain words and says how to get more detail,
 * and carries a stack only when debugging was asked for. Secrets are masked.
 */
export function FormatUnexpectedError(input: unknown, debug = false): string {
  const detail = Redact.scrubKnown(Redact.mask(debug ? errorFormat(input) : errorMessage(input)))
  return [
    "YukiOshi hit an error it has no specific advice for:",
    detail,
    debug
      ? ""
      : "Run the same command again with `--print-logs --log-level DEBUG` for details. If it keeps happening, report it with that output (API keys are masked in it).",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

type SessionErrorLike = {
  name?: string
  data?: {
    statusCode?: number
    responseHeaders?: Record<string, string>
    metadata?: Record<string, string>
  }
}

function hostOf(url: string | undefined) {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Adds the next step to a model-call failure that `yukioshi run` reports: which host could not be reached or
 * refused the key, and what to do. Only the host is named, never the full URL, and the key is never printed.
 */
export function explainSessionError(error: SessionErrorLike, message: string, providerID?: string): string {
  const status = error.data?.statusCode
  const host = hostOf(error.data?.metadata?.url)
  const text = Redact.scrubKnown(Redact.mask(message))

  if (
    status === 403 &&
    (text.includes("has not been used in project") || text.includes("is disabled") || text.includes("PERMISSION_DENIED"))
  )
    return `${text}\nThe Generative Language API has not been enabled in your project or permission was denied by the provider${host ? ` at ${host}` : ""}. Enable the API in Google Cloud Console or check your project permissions and API key.`

  if (
    error.name === "ProviderAuthError" ||
    status === 401 ||
    status === 403 ||
    (status === 400 && (text.includes("API_KEY_INVALID") || text.includes("API key not valid")))
  )
    return `${text}\nThe provider${host ? ` at ${host}` : ""} did not accept your credentials. Run \`yukioshi providers login\` to add or replace the key, or fix the API key in your environment or yukioshi.json.`

  if (status === 429) {
    const headers = error.data?.responseHeaders
    const retryAfterMs = headers?.["retry-after-ms"] ?? error.data?.metadata?.["retry-after-ms"]
    if (retryAfterMs) {
      const parsedMs = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsedMs) && parsedMs > 10_000) {
        return `${text}\nThe provider${host ? ` at ${host}` : ""} is rate limiting you (Retry-After: ${Math.round(parsedMs / 1000)}s exceeds the 10s retry limit). Wait for the retry window to pass, pick another model with --model provider/model, or set or extend fallback.models to switch automatically.`
      }
    }
    const retryAfter = headers?.["retry-after"] ?? error.data?.metadata?.["retry-after"]
    if (retryAfter) {
      const parsedSeconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(parsedSeconds)) {
        if (parsedSeconds > 10) {
          return `${text}\nThe provider${host ? ` at ${host}` : ""} is rate limiting you (Retry-After: ${parsedSeconds}s exceeds the 10s retry limit). Wait for the retry window to pass, pick another model with --model provider/model, or set or extend fallback.models to switch automatically.`
        }
      } else {
        const diffSeconds = Math.round((Date.parse(retryAfter) - Date.now()) / 1000)
        if (!Number.isNaN(diffSeconds) && diffSeconds > 10) {
          return `${text}\nThe provider${host ? ` at ${host}` : ""} is rate limiting you (Retry-After: ${diffSeconds}s exceeds the 10s retry limit). Wait for the retry window to pass, pick another model with --model provider/model, or set or extend fallback.models to switch automatically.`
        }
      }
    }
    return `${text}\nThe provider${host ? ` at ${host}` : ""} is rate limiting you or your quota is used up. Wait a moment and run again, pick another model with --model provider/model, or set or extend fallback.models to switch automatically.`
  }

  if (
    status === 404 ||
    error.name === "ProviderModelNotFoundError" ||
    text.includes("is not found for API version") ||
    text.includes("NOT_FOUND")
  )
    return `${text}\nThe provider${host ? ` at ${host}` : ""} reported that the model was not found. Check the model name, run \`yukioshi models\` to list available models, or check your configuration in yukioshi.json.`

  if (
    error.name === "ContentFilterError" ||
    text.includes("blocked by the provider's content filter") ||
    text.includes("content policy (SAFETY)")
  )
    return `${text}\nThe prompt or response was blocked by the provider's content safety filter (safety block). Modify your prompt to comply with safety guidelines, or pick another model with --model provider/model.`

  if (text.includes("empty response with no content"))
    return `${text}\nThe provider${host ? ` at ${host}` : ""} returned an empty response with no content. Check provider status, retry your prompt, or pick another model with --model provider/model.`

  const code = error.data?.metadata?.code
  const seconds = (ms: string | undefined) => (ms && Number(ms) > 0 ? `${Math.round(Number(ms) / 100) / 10}s` : undefined)
  if (code === "ProviderHeaderTimeoutError")
    return `${text}\nThe provider${host ? ` at ${host}` : ""} accepted the request but sent no response within ${seconds(error.data?.metadata?.timeoutMs) ?? "the limit"}, and the retries (2) did not help. To wait longer, raise provider.${providerID ?? "<id>"}.options.headerTimeout (milliseconds, false to disable) in yukioshi.json. To switch models automatically, set or extend fallback.models.`
  if (code === "ProviderResponseStreamError" && error.data?.metadata?.timeoutMs)
    return `${text}\nThe provider${host ? ` at ${host}` : ""} stopped sending data for ${seconds(error.data.metadata.timeoutMs)}, and the retries (2) did not help. To wait longer, raise provider.${providerID ?? "<id>"}.options.chunkTimeout (milliseconds, 0 disables the check) in yukioshi.json. To switch models automatically, set or extend fallback.models.`
  if (status !== undefined && status >= 500)
    return `${text}\nThe provider${host ? ` at ${host}` : ""} answered HTTP ${status} on every attempt (the first try plus 2 retries). Run again later, pick another model with --model provider/model, or set or extend fallback.models to switch automatically.`
  if (status === undefined && host)
    return `${text}\nYukiOshi could not reach ${host}. Check your internet connection, VPN or proxy, and the provider's baseURL. Your API key is only sent to that host and is never written to the logs.`
  return text
}
