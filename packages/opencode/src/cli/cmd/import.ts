import type { Session as SDKSession, Message, Part } from "@yukioshi/sdk/v2"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "../../session/message-v2"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Config } from "@/config/config"
import { latest, readTranscript, toExport, type Source } from "./import-transcripts"
import { Database } from "@yukioshi/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@yukioshi/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound")
      return `File not found: ${file}. Check the path, or export a session first with \`yukioshi export <sessionID> > session.json\`.`
    if (error.reason._tag === "PermissionDenied")
      return `Cannot read ${file}: permission denied. Fix the file permissions or copy it somewhere you can read.`
    if (error.reason._tag === "BadResource")
      return `${file} is not a file (it may be a directory). Pass the path of an exported session .json file or a .jsonl conversation.`
    return `Cannot read ${file}. Check that it is a readable file and try again.`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}. Import expects a file made by \`yukioshi export\`; re-export it or fix the JSON.`
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import [file]",
  describe: "import a session: an exported JSON file, a share URL, or a Claude Code or Codex conversation (.jsonl)",
  builder: (yargs) =>
    yargs
      .positional("file", {
        describe: "exported JSON file, share URL, or Claude Code or Codex .jsonl transcript",
        type: "string",
      })
      .example("$0 import session.json", "restore a session made by `yukioshi export`")
      .example("$0 import --from claude", "continue the newest Claude Code conversation held in this folder")
      .option("from", {
        type: "string",
        choices: ["claude", "codex"] as const,
        describe: "import the newest Claude Code or Codex conversation held in this folder",
      }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const conflict = importArgsError(args.from, args.file)
    if (conflict) return yield* fail(conflict)
    if (args.from) return yield* runTranscriptImport(args.from, undefined, ctx)
    if (!args.file)
      return yield* fail(
        "Name something to import: `yukioshi import session.json` (made by `yukioshi export`), a share URL, a .jsonl conversation, or use --from claude / --from codex for the newest one in this folder.",
      )
    if (args.file.endsWith(".jsonl")) return yield* runTranscriptImport(undefined, args.file, ctx)
    return yield* runImport(args.file, ctx)
  }),
})

/** `--from` picks the newest conversation itself, so it cannot be combined with a file. */
export function importArgsError(from: string | undefined, file: string | undefined) {
  if (from && file)
    return "Use --from or a file, not both. --from picks the newest conversation in this folder by itself; drop the file name, or drop --from."
}

const NAMES: Record<Source, string> = { claude: "Claude Code", codex: "Codex" }

// A Claude Code or Codex conversation, from a file or the newest one held in this folder.
const runTranscriptImport = Effect.fn("Cli.import.transcript")(function* (
  from: Source | undefined,
  file: string | undefined,
  ctx: InstanceContext,
) {
  const transcript = from ? yield* Effect.promise(() => latest(from, ctx.directory)) : file
  if (!transcript)
    return yield* fail(
      `No ${NAMES[from!]} conversation found for ${ctx.directory}. Run this from the folder you used ${NAMES[from!]} in, or pass the conversation file (.jsonl) yourself: \`yukioshi import <file>.jsonl\`.`,
    )
  if (!from && !(yield* Effect.promise(() => Bun.file(transcript).exists())))
    return yield* fail(`File not found: ${transcript}. Check the path to the .jsonl conversation file.`)
  const conversation = yield* Effect.tryPromise({
    try: () => readTranscript(transcript),
    catch: (error) =>
      new CliError({
        message: `Failed to read ${transcript}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
  if (!conversation)
    return yield* fail(
      `${transcript} is not a Claude Code or Codex conversation. Pass a .jsonl file from ~/.claude/projects or ~/.codex/sessions, or use --from claude / --from codex.`,
    )
  if (!conversation.turns.some((turn) => turn.role === "user"))
    return yield* fail(
      `${transcript} has no messages from you to import, so there is nothing to continue. Pick a conversation that has at least one prompt.`,
    )

  // Imported messages carry your configured model, so continuing the session uses it.
  const configured = (yield* (yield* Config.Service).get()).model
  const [providerID, ...modelID] = configured?.split("/") ?? []
  const model =
    configured && modelID.length
      ? { providerID: providerID!, modelID: modelID.join("/") }
      : conversation.source === "claude"
        ? { providerID: "anthropic", modelID: conversation.model ?? "claude" }
        : { providerID: "openai", modelID: conversation.model ?? "gpt" }
  const data = toExport(conversation, { ...model, directory: ctx.directory })
  yield* runImport(data as unknown as ExportData, ctx)
  process.stdout.write(
    `Imported ${data.messages.length} messages from ${NAMES[conversation.source]}. Continue with: yukioshi -s ${data.info.id}${EOL}`,
  )
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string | ExportData, ctx: InstanceContext) {
  const share = yield* ShareNext.Service
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  let exportData: ExportData | undefined = typeof file === "string" ? undefined : file

  const isUrl = typeof file === "string" && (file.startsWith("http://") || file.startsWith("https://"))

  if (typeof file !== "string") {
    // Already converted (a Claude Code or Codex conversation).
  } else if (isUrl) {
    const slug = parseShareUrl(file)
    if (!slug) {
      const baseUrl = yield* share.url().pipe(Effect.catchCause(() => Effect.succeed("https://<your-share-server>")))
      return yield* fail(
        `Not a share URL: ${file}. Expected ${baseUrl}/share/<slug>. To import a local session instead, pass the path of a file made by \`yukioshi export\`.`,
      )
    }

    const baseUrl = new URL(file).origin
    const req = yield* share
      .request()
      .pipe(
        Effect.catchCause(() =>
          fail(
            'Importing from a share URL needs a share server, and none is configured. Set "enterprise": { "url": "..." } in yukioshi.json, or import a local file made by `yukioshi export` instead.',
          ),
        ),
      )
    const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

    const tryFetch = (url: string) =>
      Effect.tryPromise({
        try: () => fetch(url, { headers }),
        catch: (e) =>
          new CliError({
            message: `Could not reach ${new URL(url).host} to fetch the shared session (${e instanceof Error ? e.message : String(e)}). Check your network connection and the URL, then try again.`,
          }),
      })

    const dataPath = req.api.data(slug)
    let response = yield* tryFetch(`${baseUrl}${dataPath}`)

    if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
      response = yield* tryFetch(`${baseUrl}/api/share/${slug}/data`)
    }

    if (!response.ok) {
      return yield* fail(
        `The share server at ${baseUrl} answered ${response.status} ${response.statusText}. Check that the share URL is correct and still exists.`,
      )
    }

    const shareData = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ShareData[]>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })
    const transformed = transformShareData(shareData)

    if (!transformed) {
      return yield* fail(`The shared session ${slug} is empty or no longer exists. Ask the owner to share it again.`)
    }

    exportData = transformed
  } else {
    exportData = (yield* fs
      .readJson(file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))) as ExportData
  }

  if (!exportData) {
    return yield* fail("The file holds no session data. Import expects a file made by `yukioshi export`.")
  }
  if (typeof exportData !== "object" || !("info" in exportData) || !Array.isArray((exportData as ExportData).messages))
    return yield* fail(
      `${typeof file === "string" ? file : "The input"} is valid JSON but not a YukiOshi session export (it needs "info" and "messages"). Create one with \`yukioshi export <sessionID>\`.`,
    )

  const info = (yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Session.Info)({
        ...exportData.info,
        projectID: ctx.project.id,
        directory: ctx.directory,
        path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
      }),
    catch: () =>
      new CliError({
        message:
          "The session in this file is not in a format this version understands. Re-export it with `yukioshi export <sessionID>` from the same or a newer version.",
      }),
  })) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of exportData.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
