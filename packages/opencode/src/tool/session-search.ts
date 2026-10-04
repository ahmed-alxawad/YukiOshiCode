import { Effect, Schema } from "effect"
import { Database } from "@yukioshi/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@yukioshi/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { eq, ne, and, or, like, desc, type SQL } from "drizzle-orm"
import DESCRIPTION from "./session-search.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search words. A session matches when its text contains all words (case-insensitive).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matching sessions to return (default 10, max 25).",
  }),
  scope: Schema.optional(Schema.Literals(["project", "all"])).annotate({
    description: 'Search scope: "project" (default, current project only) or "all" (every project).',
  }),
})

function parseJson<T>(val: unknown): T | undefined {
  if (typeof val === "object" && val !== null) return val as T
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T
    } catch {
      return undefined
    }
  }
  return undefined
}

function createSnippet(text: string, matchIndex: number, targetLength = 300): string {
  if (text.length <= targetLength) {
    return text.trim()
  }
  const half = Math.floor(targetLength / 2)
  let start = Math.max(0, matchIndex - half)
  let end = Math.min(text.length, start + targetLength)
  if (end - start < targetLength) {
    start = Math.max(0, end - targetLength)
  }
  let snippet = text.slice(start, end).trim()
  if (start > 0) snippet = "..." + snippet
  if (end < text.length) snippet = snippet + "..."
  return snippet
}

type RawPartData = {
  type?: string
  text?: string
  synthetic?: boolean
}

type RawMessageData = {
  role?: string
}

type SessionGroup = {
  id: string
  title: string
  time_updated: number
  parts: Array<{
    role: "user" | "assistant"
    text: string
    time_created: number
  }>
}

export const SessionSearchTool = Tool.define(
  "session_search",
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const query = params.query.trim()
          const words = query.split(/\s+/).filter(Boolean)
          if (words.length === 0) {
            return {
              title: "Session search",
              output: "No search words provided.",
              metadata: { matches: 0, sessions: [] },
            }
          }

          yield* ctx.ask({
            permission: "session_search",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              limit: params.limit,
              scope: params.scope,
            },
          })

          const lowerWords = words.map((w) => w.toLowerCase())
          const limit = Math.min(Math.max(params.limit ?? 10, 1), 25)
          const scope = params.scope ?? "project"
          const ins = yield* InstanceState.context

          const sessionConditions: SQL[] = [ne(SessionTable.id, ctx.sessionID)]
          if (scope === "project") {
            sessionConditions.push(eq(SessionTable.project_id, ins.project.id))
          }

          const wordLikes = words.flatMap((w) => [
            like(PartTable.data, `%${w}%`),
            like(PartTable.data, `%${w.toLowerCase()}%`),
            like(PartTable.data, `%${w.toUpperCase()}%`),
          ])

          const rows = yield* db
            .select({
              session_id: SessionTable.id,
              session_title: SessionTable.title,
              session_updated: SessionTable.time_updated,
              session_project_id: SessionTable.project_id,
              message_id: MessageTable.id,
              message_time_created: MessageTable.time_created,
              message_data: MessageTable.data,
              part_id: PartTable.id,
              part_time_created: PartTable.time_created,
              part_data: PartTable.data,
            })
            .from(PartTable)
            .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
            .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
            .where(and(...sessionConditions, or(...wordLikes)))
            .orderBy(desc(SessionTable.time_updated), SessionTable.id, PartTable.time_created)
            .all()
            .pipe(Effect.orDie)

          const sessionMap = new Map<string, SessionGroup>()
          for (const row of rows) {
            const partData = parseJson<RawPartData>(row.part_data)
            const messageData = parseJson<RawMessageData>(row.message_data)

            if (!partData || partData.type !== "text" || partData.synthetic === true) continue
            if (typeof partData.text !== "string" || partData.text.length === 0) continue
            if (!messageData || (messageData.role !== "user" && messageData.role !== "assistant")) continue

            let group = sessionMap.get(row.session_id)
            if (!group) {
              group = {
                id: row.session_id,
                title: row.session_title,
                time_updated: row.session_updated,
                parts: [],
              }
              sessionMap.set(row.session_id, group)
            }
            group.parts.push({
              role: messageData.role as "user" | "assistant",
              text: partData.text,
              time_created: row.part_time_created,
            })
          }

          const matchingSessions: Array<{
            id: string
            title: string
            time_updated: number
            role: "user" | "assistant"
            snippet: string
          }> = []

          for (const session of sessionMap.values()) {
            const allSessionText = session.parts.map((p) => p.text).join(" ").toLowerCase()
            const matchesAll = lowerWords.every((w) => allSessionText.includes(w))
            if (!matchesAll) continue

            session.parts.sort((a, b) => a.time_created - b.time_created)

            const fullQueryLower = query.toLowerCase()
            let bestPart = session.parts.find((p) => p.text.toLowerCase().includes(fullQueryLower))
            if (!bestPart) {
              bestPart = session.parts.find((p) => {
                const lower = p.text.toLowerCase()
                return lowerWords.every((w) => lower.includes(w))
              })
            }
            if (!bestPart) {
              bestPart = session.parts.find((p) => {
                const lower = p.text.toLowerCase()
                return lowerWords.some((w) => lower.includes(w))
              })
            }
            if (!bestPart) continue

            const lower = bestPart.text.toLowerCase()
            let matchIdx = lower.indexOf(fullQueryLower)
            if (matchIdx === -1) {
              for (const word of lowerWords) {
                const idx = lower.indexOf(word)
                if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
                  matchIdx = idx
                }
              }
            }

            const snippet = createSnippet(bestPart.text, Math.max(0, matchIdx), 300)

            matchingSessions.push({
              id: session.id,
              title: session.title,
              time_updated: session.time_updated,
              role: bestPart.role,
              snippet,
            })
          }

          matchingSessions.sort((a, b) => b.time_updated - a.time_updated || b.id.localeCompare(a.id))
          const limited = matchingSessions.slice(0, limit)

          if (limited.length === 0) {
            return {
              title: `Session search: "${query}"`,
              output: `No sessions matched "${query}".`,
              metadata: { matches: 0, sessions: [] },
            }
          }

          const lines: string[] = []
          for (const s of limited) {
            lines.push(`Session: ${s.title} (${s.id})`)
            lines.push(`Updated: ${new Date(s.time_updated).toISOString()}`)
            lines.push(`Role: ${s.role}`)
            lines.push(`Snippet: ${s.snippet}`)
            lines.push("")
          }

          return {
            title: `Session search: ${limited.length} match${limited.length === 1 ? "" : "es"}`,
            output: lines.join("\n").trimEnd(),
            metadata: {
              matches: limited.length,
              sessions: limited.map((s) => s.id),
            },
          }
        }),
    }
  }),
)
