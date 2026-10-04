import { ConfigToolSearchV1 } from "@yukioshi/core/v1/config/tool-search"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { isRecord } from "@/util/record"

export interface DeferredTool {
  name: string
  description: string
  inputSchema: unknown
}

export const DEFAULT_THRESHOLD = ConfigToolSearchV1.DEFAULT_THRESHOLD
export const DEFAULT_ENABLED = ConfigToolSearchV1.DEFAULT_ENABLED

/**
 * Parse an exact tool selection query in the form "select:name1,name2".
 * Returns an array of trimmed tool names, or null if the query is not a select query.
 */
export function parseSelectQuery(query: string): string[] | null {
  const trimmed = query.trim()
  if (!trimmed.toLowerCase().startsWith("select:")) return null
  const rest = trimmed.slice("select:".length).trim()
  if (!rest) return []
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Score and rank deferred MCP tools based on query words matching name and description.
 * Returns up to `limit` tools (default 5, capped at `max` 10).
 */
export function rankDeferredTools(
  tools: DeferredTool[],
  query: string,
  limit = 5,
  max = 10,
): DeferredTool[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
  if (words.length === 0) return []

  const scored: Array<{ tool: DeferredTool; score: number }> = []

  for (const tool of tools) {
    const nameLower = tool.name.toLowerCase()
    const descLower = (tool.description || "").toLowerCase()
    let score = 0
    let matchedWords = 0

    for (const w of words) {
      let wordMatched = false
      if (nameLower === w) {
        score += 100
        wordMatched = true
      } else if (
        nameLower.startsWith(w) ||
        nameLower.includes(`_${w}`) ||
        nameLower.includes(`-${w}`) ||
        nameLower.includes(`:${w}`)
      ) {
        score += 40
        wordMatched = true
      } else if (nameLower.includes(w)) {
        score += 20
        wordMatched = true
      }

      if (descLower.includes(w)) {
        score += 5
        wordMatched = true
      }

      if (wordMatched) matchedWords++
    }

    if (matchedWords === words.length && words.length > 1) {
      score += 50
    }

    if (score > 0) {
      scored.push({ tool, score })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  const count = Math.min(Math.max(limit, 1), max)
  return scored.slice(0, count).map((s) => s.tool)
}

/**
 * Execute search over deferred MCP tools, supporting either "select:name1,name2"
 * or keyword ranking.
 */
export function executeToolSearch(deferredTools: DeferredTool[], query: string): DeferredTool[] {
  const selectNames = parseSelectQuery(query)
  if (selectNames !== null) {
    if (selectNames.length === 0) return []
    const toolMap = new Map(deferredTools.map((t) => [t.name, t]))
    const selected: DeferredTool[] = []
    const seen = new Set<string>()
    for (const name of selectNames) {
      if (seen.has(name)) continue
      seen.add(name)
      const found = toolMap.get(name)
      if (found) selected.push(found)
    }
    return selected.slice(0, 10)
  }

  return rankDeferredTools(deferredTools, query, 5, 10)
}

/**
 * Calculate the total JSON character length of MCP tool definitions
 * (JSON of name + description + input schema together).
 */
export function calculateMcpDefinitionsSize(
  tools: Record<string, { def: { name: string; description?: string; inputSchema?: unknown } }>,
): number {
  const defs = Object.entries(tools).map(([key, entry]) => ({
    name: key,
    description: entry.def.description ?? "",
    inputSchema: entry.def.inputSchema ?? {},
  }))
  return JSON.stringify(defs).length
}

/**
 * Decide whether tool search mode is active based on config and definition size.
 * "auto" activates when definition size exceeds the threshold (default 20000 chars).
 * true = always active, false = never active.
 */
export function isSearchMode(
  config: ConfigToolSearchV1.Info | undefined,
  totalChars: number,
): boolean {
  const enabled = config?.enabled ?? DEFAULT_ENABLED
  if (enabled === true) return true
  if (enabled === false) return false
  const threshold = config?.threshold ?? DEFAULT_THRESHOLD
  return totalChars > threshold
}

/**
 * Derive tool names loaded in the current session from history.
 * Reads metadata.loaded from completed tool_search parts in `input.messages`.
 */
export function loadedToolsFromHistory(messages: readonly SessionV1.WithParts[]): Set<string> {
  const loaded = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool === "tool_search" && part.state.status === "completed") {
        const meta = part.state.metadata
        if (isRecord(meta) && Array.isArray(meta.loaded)) {
          for (const item of meta.loaded) {
            if (typeof item === "string") loaded.add(item)
          }
        }
      }
    }
  }
  return loaded
}

/**
 * Format description for the `tool_search` tool, listing deferred tool names
 * with a <=80-character description each.
 */
export function formatToolSearchDescription(deferredTools: DeferredTool[]): string {
  const header =
    "Search and load deferred MCP tools into this session. Call with keywords to find tools or 'select:name1,name2' for exact tools.\n\nAvailable deferred tools:"
  if (deferredTools.length === 0) {
    return `${header}\n(None remaining; all MCP tools are loaded)`
  }
  const lines = [header]
  for (const tool of deferredTools) {
    const rawDesc = (tool.description || "").replace(/\s+/g, " ").trim()
    const desc = rawDesc.length > 80 ? rawDesc.slice(0, 77) + "..." : rawDesc
    lines.push(desc ? `- ${tool.name}: ${desc}` : `- ${tool.name}`)
  }
  return lines.join("\n")
}
