import type { CancelTaskInput, ReadDiffInput, StartTaskInput } from "./contracts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

export function validateNoPayload(value: unknown): void {
  if (value !== undefined) throw new TypeError("This operation does not accept a payload")
}

export function validateRelativePath(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ["path"]) || typeof value.path !== "string") {
    throw new TypeError("A path string is required")
  }
  if (!value.path || value.path.includes("\0") || value.path.length > 4096) throw new TypeError("Invalid path")
  return value.path
}

export function validateStartTask(value: unknown): StartTaskInput {
  if (!isRecord(value) || !hasExactKeys(value, ["prompt"]) || typeof value.prompt !== "string") {
    throw new TypeError("A prompt string is required")
  }
  const prompt = value.prompt.trim()
  if (!prompt || prompt.length > 100_000) throw new TypeError("Invalid prompt")
  return { prompt }
}

export function validateReadDiff(value: unknown): ReadDiffInput {
  if (!isRecord(value) || !hasExactKeys(value, value.path === undefined ? ["source"] : ["path", "source"])) {
    throw new TypeError("A diff source is required")
  }
  if (value.source !== "git" && value.source !== "session") throw new TypeError("Invalid diff source")
  if (value.path === undefined) return { source: value.source }
  if (
    typeof value.path !== "string" ||
    !value.path ||
    value.path.includes("\0") ||
    value.path.length > 4096 ||
    value.path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value.path) ||
    value.path.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError("Invalid diff path")
  }
  return { source: value.source, path: value.path }
}

export function validateCancelTask(value: unknown): CancelTaskInput {
  if (!isRecord(value) || !hasExactKeys(value, ["taskId"]) || typeof value.taskId !== "string") {
    throw new TypeError("A task ID is required")
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.taskId)) throw new TypeError("Invalid task ID")
  return { taskId: value.taskId }
}
