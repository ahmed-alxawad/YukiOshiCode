import { createStore, produce, reconcile } from "solid-js/store"

export type MessageMode = "steer" | "queue"

export const DEFAULT_MESSAGE_MODE: MessageMode = "queue"

function valid(value: unknown): value is MessageMode {
  return value === "steer" || value === "queue"
}

/** Stored choice (kv) wins over tui.json `message_mode`; the default is "queue". */
export function resolveMessageMode(stored: unknown, configured: unknown): MessageMode {
  if (valid(stored)) return stored
  if (valid(configured)) return configured
  return DEFAULT_MESSAGE_MODE
}

export function toggleMessageMode(mode: MessageMode): MessageMode {
  return mode === "queue" ? "steer" : "queue"
}

export type Held = { id: number; text: string; send: () => Promise<unknown> | unknown }

/**
 * Per-session in-memory list of messages held by the client until the session
 * is idle. `pump(sessionID, idle)` is called whenever the busy/idle status
 * changes (or a message is added); it sends the next held message when idle
 * and waits for that turn to start and finish before sending the next.
 */
/**
 * Some held messages never start a turn (`/loop status` and other commands answered directly), so no
 * busy status ever arrives. If none has arrived this long after the send settled, the next message goes.
 */
const NO_TURN_GRACE_MS = 2_000

export function createMessageQueue(options: { noTurnGraceMs?: number } = {}) {
  const grace = options.noTurnGraceMs ?? NO_TURN_GRACE_MS
  const [store, setStore] = createStore<{ held: Record<string, { id: number; text: string }[]> }>({ held: {} })
  const items = new Map<string, Held[]>()
  // The send each session is waiting on; cleared once its turn starts (busy) or it turned out to start none.
  const inFlight = new Map<string, object>()
  let seq = 0

  function sync(sessionID: string) {
    const list = items.get(sessionID) ?? []
    setStore(
      produce((draft) => {
        draft.held[sessionID] = list.map((x) => ({ id: x.id, text: x.text }))
      }),
    )
  }

  const api = {
    held: (sessionID: string) => store.held[sessionID] ?? [],
    size: (sessionID: string) => items.get(sessionID)?.length ?? 0,
    /** Should a message typed now be held rather than sent? */
    shouldHold(mode: MessageMode, busy: boolean, sessionID: string) {
      return mode === "queue" && (busy || (items.get(sessionID)?.length ?? 0) > 0 || inFlight.has(sessionID))
    },
    add(sessionID: string, text: string, send: Held["send"]) {
      const list = items.get(sessionID) ?? []
      list.push({ id: ++seq, text, send })
      items.set(sessionID, list)
      sync(sessionID)
    },
    pump(sessionID: string, idle: boolean) {
      if (!idle) {
        inFlight.delete(sessionID)
        return
      }
      if (inFlight.has(sessionID)) return
      const next = items.get(sessionID)?.shift()
      if (!next) return
      sync(sessionID)
      const token = {}
      inFlight.set(sessionID, token)
      const release = () => {
        if (inFlight.get(sessionID) !== token) return
        inFlight.delete(sessionID)
        queueMicrotask(() => api.pump(sessionID, true))
      }
      const settled = () => setTimeout(release, grace)
      try {
        Promise.resolve(next.send()).then(settled, release)
      } catch {
        release()
      }
    },
    /** Quit/ctrl-c: discard everything held. */
    clear() {
      items.clear()
      inFlight.clear()
      setStore("held", reconcile({}))
    },
  }
  return api
}

export const messageQueue = createMessageQueue()
