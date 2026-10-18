import path from "path"
import { readFileSync, existsSync, statSync } from "fs"
import { ConfigAgent } from "./agent"

export const MAX_SESSION_AGENTS_BYTES = 64 * 1024

// Parses the `--agents` value: inline JSON or a path to a JSON file. Returns the validated
// JSON text (what YUKIOSHI_SESSION_AGENTS carries) or throws an Error with a readable message.
export function parseSessionAgents(value: string, cwd = process.cwd()): string {
  let text = value.trim()
  if (!text.startsWith("{")) {
    const file = path.resolve(cwd, text)
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`--agents: "${value}" is neither a JSON object nor a readable file`)
    if (statSync(file).size > MAX_SESSION_AGENTS_BYTES) throw new Error(`--agents: ${file} is larger than 64 KB`)
    text = readFileSync(file, "utf8")
  }
  if (Buffer.byteLength(text) > MAX_SESSION_AGENTS_BYTES) throw new Error("--agents: JSON is larger than 64 KB")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`--agents: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("--agents: expected a JSON object mapping agent names to definitions")
  ConfigAgent.fromRecord(parsed as Record<string, unknown>)
  return JSON.stringify(parsed)
}
