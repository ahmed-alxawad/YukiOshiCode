// Where the Kothora API lives. The default host is a placeholder (the .invalid top-level domain never
// resolves) and is to be set: export KOTHORA_API_URL before running, or put it in the environment of the app.
export const DEFAULT_API_URL = "https://api.kothora.invalid"

export function apiUrl(env: Record<string, string | undefined> = process.env) {
  const value = env["KOTHORA_API_URL"]?.trim()
  return (value ? value : DEFAULT_API_URL).replace(/\/+$/, "")
}

export const PROVIDER_ID = "kothora"
