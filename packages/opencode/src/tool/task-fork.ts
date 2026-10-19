import { Effect } from "effect"
import { Redact } from "@yukioshi/core/redact"
import type { SessionV1 } from "@yukioshi/core/v1/session"
import { MessageV2 } from "../session/message-v2"
import { MessageID, PartID, type SessionID } from "../session/schema"
import { Token } from "../util/token"
import type { Session } from "../session/session"

/** Most history a fork child inherits, in estimated tokens. */
export const FORK_MAX_TOKENS = 200_000

export function forkSubagents(cfg: { readonly subagents?: { readonly fork?: boolean } }) {
  return cfg.subagents?.fork === true
}

/**
 * Parent messages (oldest first) before the task call, cut at the parent's compaction summary, with the oldest
 * tool outputs marked compacted (the same marker compaction uses) until the history fits the cap.
 */
export function forkHistory(msgs: SessionV1.WithParts[], untilID: MessageID, maxTokens = FORK_MAX_TOKENS) {
  const cut = msgs.findIndex((msg) => msg.info.id === untilID)
  // If a race leaves untilID missing from the snapshot, ids are time-ordered
  // (Identifier.ascending), so keep only the messages created before it instead of everything.
  const sliced = cut < 0 ? msgs.filter((msg) => msg.info.id < untilID) : msgs.slice(0, cut)
  const history = MessageV2.filterCompacted(sliced.toReversed()).map((msg) => structuredClone(msg))
  // MessageV2.latest would queue these subtask parts in the child, where prompt.ts dispatches
  // them with bypassAgentCheck and so bypasses the child's task deny; finished ones are history.
  const queued = new Set<SessionV1.Part>(
    MessageV2.latest(history).tasks.filter((part) => part.type === "subtask"),
  )
  for (const msg of history) msg.parts = msg.parts.filter((part) => !queued.has(part))
  const size = (msg: SessionV1.WithParts) => Token.estimate(JSON.stringify(msg))
  let total = history.reduce((sum, msg) => sum + size(msg), 0)
  for (const msg of history) {
    for (const part of msg.parts) {
      if (total <= maxTokens) return history
      if (part.type !== "tool" || part.state.status !== "completed" || part.state.time.compacted) continue
      const before = Token.estimate(part.state.output)
      part.state.time.compacted = Date.now()
      total -= before
    }
  }
  return history
}

/** Copies the history into the child session, masking secrets as exports do. */
export const copyForkHistory = Effect.fn("TaskFork.copy")(function* (
  sessions: Session.Interface,
  input: {
    from: SessionID
    to: SessionID
    until: MessageID
    redact?: Parameters<typeof Redact.maskDeep>[1]
  },
) {
  const history = forkHistory(yield* sessions.messages({ sessionID: input.from }), input.until)
  const ids = new Map<string, MessageID>()
  for (const msg of history) {
    const id = MessageID.ascending()
    ids.set(msg.info.id, id)
    const parentID = msg.info.role === "assistant" ? ids.get(msg.info.parentID) : undefined
    yield* sessions.updateMessage({
      ...msg.info,
      sessionID: input.to,
      id,
      ...(parentID && { parentID }),
    } as SessionV1.Info)
    for (const part of msg.parts) {
      const copy = Redact.maskDeep(
        {
          ...part,
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.to,
        },
        input.redact,
      ) as SessionV1.Part
      if (copy.type === "compaction" && copy.tail_start_id) copy.tail_start_id = ids.get(copy.tail_start_id)
      yield* sessions.updatePart(copy)
    }
  }
})
