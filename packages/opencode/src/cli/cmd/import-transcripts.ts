// Importing Claude Code and Codex conversations (`yukioshi import <file.jsonl>`, `yukioshi import --from claude`).
// What the person asked and what the agent answered are kept as they were. Tool calls become short notes, with
// their output shortened, so the session reads well and can be continued with any model.

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Slug } from "@yukioshi/core/util/slug"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { MessageID, PartID, SessionID } from "@/session/schema"

export type Source = "claude" | "codex"

type Tool = { name: string; input: unknown; output?: string }
type Block = { kind: "text"; text: string } | { kind: "tool"; id: string }
type Turn = { role: "user"; text: string; time: number } | { role: "assistant"; blocks: Block[]; time: number }

export type Conversation = {
  source: Source
  title?: string
  directory?: string
  model?: string
  turns: Turn[]
  tools: Map<string, Tool>
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB
const MAX_LINE_LENGTH = 1_048_576 // 1 MB
const OUTPUT_MAX = 2_000
const DETAIL_MAX = 200

// Text the tools add on the person's behalf (environment details, command echoes, notifications), not their words.
const INJECTED_TAGS =
  "environment_context|user_instructions|permissions instructions|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|task-notification|user-prompt-submit-hook"

const INJECTED_START = new RegExp(`^<\\s*\\/?\\s*(?:${INJECTED_TAGS})(?:\\s+[^>]*|\\s*)>`, "i")
const INJECTED_BLOCK = new RegExp(`<(?:${INJECTED_TAGS})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/(?:${INJECTED_TAGS})>`, "gi")

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}

export function sanitizeTitle(raw: string): string {
  let title = raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\r\n\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (title.includes("..") || path.isAbsolute(title) || /^[a-zA-Z]:[\\/]/.test(title)) {
    title = path.basename(title) || "conversation"
  }
  title = title.replace(/[/\\]/g, " ").replace(/\s+/g, " ").trim()
  return clip(title || "conversation", 100)
}

export function sanitizeToolName(name: string): string {
  const cleaned = name
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[*`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return clip(cleaned || "tool", 64)
}

function time(value: unknown, fallback: number) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function words(text: string) {
  const stripped = text.replace(INJECTED_BLOCK, "").trim()
  return stripped && !INJECTED_START.test(stripped) ? stripped : undefined
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((item) =>
        item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : "",
      )
      .filter(Boolean)
      .join("\n")
  return ""
}

class Builder {
  turns: Turn[] = []
  tools = new Map<string, Tool>()

  user(text: string, at: number) {
    const last = this.turns.at(-1)
    if (last?.role === "user") last.text = `${last.text}\n\n${text}`
    else this.turns.push({ role: "user", text, time: at })
  }

  private assistant(at: number) {
    const last = this.turns.at(-1)
    if (last?.role === "assistant") return last
    const turn: Turn = { role: "assistant", blocks: [], time: at }
    this.turns.push(turn)
    return turn
  }

  text(text: string, at: number) {
    if (text.trim()) this.assistant(at).blocks.push({ kind: "text", text: text.trim() })
  }

  tool(id: string, name: string, input: unknown, at: number) {
    this.tools.set(id, { name, input })
    this.assistant(at).blocks.push({ kind: "tool", id })
  }

  output(id: string, output: string) {
    const tool = this.tools.get(id)
    if (tool) tool.output = output
  }
}

function parse(content: string) {
  return content
    .split("\n")
    .filter((line) => line.trim() && line.length <= MAX_LINE_LENGTH)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line)
        return value && typeof value === "object" ? [value as Record<string, any>] : []
      } catch {
        return []
      }
    })
}

/** Which tool wrote the transcript, from its lines. */
export function detect(lines: Record<string, any>[]): Source | undefined {
  if (lines.some((line) => line.type === "session_meta" || line.type === "response_item")) return "codex"
  if (lines.some((line) => (line.type === "user" || line.type === "assistant") && line.message)) return "claude"
  return undefined
}

export function fromClaude(lines: Record<string, any>[], now = Date.now()): Conversation {
  const build = new Builder()
  let title: string | undefined
  let directory: string | undefined
  let model: string | undefined
  for (const line of lines) {
    if (typeof line.aiTitle === "string") title = line.aiTitle
    else if (line.type === "summary" && typeof line.summary === "string") title ??= line.summary
    // Subagent conversations and lines the tool adds for itself are not part of the conversation.
    if (line.isSidechain || line.isMeta || (line.type !== "user" && line.type !== "assistant")) continue
    directory ??= typeof line.cwd === "string" ? line.cwd : undefined
    const at = time(line.timestamp, now)
    const content = line.message?.content
    if (line.type === "assistant") {
      if (typeof line.message?.model === "string" && !line.message.model.startsWith("<")) model = line.message.model
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === "text") build.text(String(block.text ?? ""), at)
        if (block?.type === "tool_use") build.tool(String(block.id), String(block.name), block.input, at)
      }
      continue
    }
    if (typeof content === "string") {
      const text = words(content)
      if (text) build.user(text, at)
      continue
    }
    const said: string[] = []
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "tool_result") build.output(String(block.tool_use_id), textOf(block.content))
      if (block?.type === "text") {
        const text = words(String(block.text ?? ""))
        if (text) said.push(text)
      }
    }
    if (said.length) build.user(said.join("\n\n"), at)
  }
  return { source: "claude", title, directory, model, turns: build.turns, tools: build.tools }
}

export function fromCodex(lines: Record<string, any>[], now = Date.now()): Conversation {
  const build = new Builder()
  let directory: string | undefined
  let model: string | undefined
  for (const line of lines) {
    const payload = line.payload ?? {}
    const at = time(line.timestamp, now)
    if (line.type === "session_meta") directory ??= typeof payload.cwd === "string" ? payload.cwd : undefined
    if (line.type === "turn_context" && typeof payload.model === "string") model = payload.model
    if (line.type !== "response_item") continue
    if (payload.type === "message" && payload.role === "user") {
      const text = words(textOf(payload.content))
      if (text) build.user(text, at)
    }
    if (payload.type === "message" && payload.role === "assistant") build.text(textOf(payload.content), at)
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      let input: unknown = payload.arguments ?? payload.input
      if (typeof input === "string" && payload.type === "function_call") {
        try {
          input = JSON.parse(input)
        } catch {}
      }
      build.tool(String(payload.call_id), String(payload.name), input, at)
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      let output = typeof payload.output === "string" ? payload.output : textOf(payload.output)
      try {
        const value = JSON.parse(output)
        if (value && typeof value.output === "string") output = value.output
      } catch {}
      build.output(String(payload.call_id), output)
    }
  }
  return { source: "codex", directory, model, turns: build.turns, tools: build.tools }
}

function detail(input: unknown) {
  if (typeof input === "string") return clip(input.split("\n")[0] ?? "", DETAIL_MAX)
  if (!input || typeof input !== "object") return ""
  const value = input as Record<string, unknown>
  for (const key of ["command", "cmd", "file_path", "filePath", "path", "pattern", "url", "query", "description"]) {
    const item = value[key]
    if (typeof item === "string") return clip(item, DETAIL_MAX)
    if (Array.isArray(item) && item.every((part) => typeof part === "string")) return clip(item.join(" "), DETAIL_MAX)
  }
  try {
    return clip(JSON.stringify(input), DETAIL_MAX)
  } catch {
    return ""
  }
}

function note(tool: Tool) {
  const cleanName = sanitizeToolName(tool.name)
  const what = clip(detail(tool.input).replace(/\s+/g, " ").trim(), DETAIL_MAX)
  const head = `**${cleanName}**${what ? ` \`${what.replaceAll("`", "'")}\`` : ""}`
  const output = tool.output?.trim()
  return output ? `${head}\n\`\`\`\n${clip(output, OUTPUT_MAX).replaceAll("```", "'''")}\n\`\`\`` : head
}

const NAMES: Record<Source, string> = { claude: "Claude Code", codex: "Codex" }

/** The conversation as an exported YukiOshi session, ready for the importer. */
export function toExport(
  conversation: Conversation,
  input: { providerID: string; modelID: string; directory: string },
) {
  const first = conversation.turns.find((turn) => turn.role === "user")
  const firstWords = first?.role === "user" ? first.text.replace(/\s+/g, " ").slice(0, 60) : "conversation"
  const sessionID = SessionID.descending()
  const created = conversation.turns[0]?.time ?? Date.now()
  const updated = conversation.turns.at(-1)?.time ?? created
  const messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> = []
  let parentID: string | undefined
  for (const turn of conversation.turns) {
    const id = MessageID.ascending()
    if (turn.role === "user") {
      parentID = id
      messages.push({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created: turn.time },
          agent: "build",
          model: { providerID: input.providerID, modelID: input.modelID },
        },
        parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: turn.text }],
      })
      continue
    }
    // An answer needs the question it answers; anything before the first question is left out.
    if (!parentID) continue
    const parts = turn.blocks.map((block) => ({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: block.kind === "text" ? block.text : note(conversation.tools.get(block.id)!),
    }))
    if (!parts.length) continue
    messages.push({
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: input.directory, root: input.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.modelID,
        providerID: input.providerID,
        time: { created: turn.time, completed: turn.time },
        finish: "stop",
      },
      parts,
    })
  }
  return {
    info: {
      id: sessionID,
      slug: Slug.create(),
      projectID: "global",
      directory: input.directory,
      title: `${sanitizeTitle(conversation.title ?? firstWords)} (from ${NAMES[conversation.source]})`,
      version: InstallationVersion,
      time: { created, updated },
    },
    messages,
  }
}

export async function readTranscript(file: string) {
  const stat = await fs.stat(file)
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Transcript file is too large: ${file} (max 50 MB)`)
  }
  const lines = parse(await fs.readFile(file, "utf8"))
  const source = detect(lines)
  if (!source) return undefined
  return source === "claude" ? fromClaude(lines) : fromCodex(lines)
}

async function newest(files: string[]) {
  const stats = await Promise.all(
    files.map((file) =>
      fs
        .stat(file)
        .then((stat) => ({ file, mtime: stat.mtimeMs }))
        .catch(() => undefined),
    ),
  )
  return stats
    .filter((item): item is { file: string; mtime: number } => item !== undefined)
    .toSorted((a, b) => b.mtime - a.mtime)
    .map((item) => item.file)
}

async function list(dir: string, match: (name: string) => boolean, depth = 0): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 4) return list(full, match, depth + 1)
      return Promise.resolve(entry.isFile() && match(entry.name) ? [full] : [])
    }),
  )
  return nested.flat()
}

/** The newest Claude Code or Codex conversation that was held in `directory`. */
export async function latest(source: Source, directory: string, home = os.homedir()) {
  if (source === "claude") {
    const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")
    const folder = path.join(root, "projects", directory.replace(/[^a-zA-Z0-9]/g, "-"))
    return (await newest(await list(folder, (name) => name.endsWith(".jsonl"))))[0]
  }
  const root = path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "sessions")
  for (const file of await newest(await list(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")))) {
    const handle = await fs.open(file, "r").catch(() => undefined)
    if (!handle) continue
    const head = await handle
      .read({ buffer: Buffer.alloc(64 * 1024), position: 0 })
      .then((read) => read.buffer.subarray(0, read.bytesRead).toString("utf8").split("\n")[0] ?? "")
      .finally(() => handle.close())
    try {
      const meta = JSON.parse(head)
      if (meta?.type === "session_meta" && path.resolve(String(meta.payload?.cwd ?? "")) === path.resolve(directory))
        return file
    } catch {}
  }
  return undefined
}
