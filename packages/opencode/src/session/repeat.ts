// /loop: run a prompt (or a slash command) again on an interval in the current session, like Claude
// Code's /loop. On by default (`"loop": { "enabled": false }` turns it off). A loop lives as long as
// the YukiOshi process: it stops with /loop stop, when a run fails or is interrupted, or after
// `loop.max_runs` runs.

export const DEFAULT_INTERVAL_MS = 10 * 60_000
export const DEFAULT_MAX_RUNS = 50
export const DEFAULT_MIN_INTERVAL_S = 60
/** Longest delay the agent may pick for itself in a self-paced loop, in seconds. */
export const MAX_WAIT_S = 3600

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "90s", "5m", "1h30m" in milliseconds, or undefined when the text is not an interval. */
export function parseInterval(text: string) {
  if (!/^(\d+[smhd])+$/i.test(text)) return undefined
  let total = 0
  for (const [, amount, unit] of text.toLowerCase().matchAll(/(\d+)([smhd])/g)) total += Number(amount) * UNIT[unit!]!
  return total > 0 ? total : undefined
}

export type Parsed =
  | { readonly kind: "status" }
  | { readonly kind: "stop" }
  | { readonly kind: "start"; readonly intervalMs: number; readonly prompt: string; readonly clamped: boolean; readonly selfPaced?: true }
  | { readonly kind: "invalid"; readonly message: string }

/** `/loop [interval] <prompt or /command>`, `/loop stop`, or `/loop` for the status. */
export function parse(args: string, minIntervalS = DEFAULT_MIN_INTERVAL_S): Parsed {
  const text = args.trim()
  if (!text || text.toLowerCase() === "status") return { kind: "status" }
  if (text.toLowerCase() === "stop") return { kind: "stop" }
  const [first, ...rest] = text.split(/\s+/)
  const interval = parseInterval(first!)
  const prompt = (interval === undefined ? text : rest.join(" ")).trim()
  if (!prompt) return { kind: "invalid", message: "Say what to run: /loop 5m <prompt or /command>." }
  const min = minIntervalS * 1000
  const wanted = interval ?? DEFAULT_INTERVAL_MS
  return {
    kind: "start",
    intervalMs: Math.max(wanted, min),
    prompt,
    clamped: interval !== undefined && wanted < min,
    ...(interval === undefined ? { selfPaced: true as const } : {}),
  }
}

export function duration(ms: number) {
  const parts: string[] = []
  let rest = Math.round(ms / 1000)
  for (const [unit, size] of [
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(rest / size)
    if (amount > 0) parts.push(`${amount}${unit}`)
    rest -= amount * size
  }
  return parts.join("") || "0s"
}

export interface Active {
  readonly prompt: string
  readonly intervalMs: number
  readonly runs: number
  readonly maxRuns: number
  readonly nextAt?: number
  /** No interval was given: the agent picks the delay with loop_wait (10 minutes if it does not). */
  readonly selfPaced?: boolean
  /** Why the agent chose the current delay. */
  readonly reason?: string
}

// Self-paced loops: while a self-paced run is going, the loop_wait tool may record the delay before the
// next run (or a request to stop). The scheduler reads it when the run ends.
export interface Wait {
  readonly seconds?: number
  readonly stop?: boolean
  readonly reason?: string
}
const paced = new Map<string, { minS: number; wait?: Wait }>()

export function clampWait(seconds: number, minS = DEFAULT_MIN_INTERVAL_S) {
  return Math.min(Math.max(Math.round(seconds), minS), Math.max(MAX_WAIT_S, minS))
}

export function beginPaced(sessionID: string, minS: number) {
  paced.set(sessionID, { minS })
}

/** Ends a self-paced run and returns what the agent asked for, if anything. */
export function endPaced(sessionID: string): Wait | undefined {
  const entry = paced.get(sessionID)
  paced.delete(sessionID)
  return entry?.wait
}

/** Records the agent's choice. Fails outside a self-paced loop run. */
export function requestWait(
  sessionID: string,
  input: { seconds?: number; reason?: string; stop?: boolean },
): { ok: true; wait: Wait } | { ok: false; message: string } {
  const entry = paced.get(sessionID)
  if (!entry) return { ok: false, message: "loop_wait only works inside a self-paced /loop run." }
  const reason = input.reason?.trim().slice(0, 200) || undefined
  if (input.stop) entry.wait = { stop: true, reason }
  else if (input.seconds !== undefined && Number.isFinite(input.seconds))
    entry.wait = { seconds: clampWait(input.seconds, entry.minS), reason }
  else return { ok: false, message: "Give seconds, or stop: true." }
  return { ok: true, wait: entry.wait }
}

export function status(active: Active | undefined, stoppedNote?: string, now = Date.now()) {
  if (!active)
    return [stoppedNote, "No loop is running. Start one with /loop 5m <prompt or /command>, or /loop <prompt> to let the agent pick the delay."].filter(Boolean).join("\n")
  return [
    `Looping ${active.selfPaced ? "self-paced, next delay" : "every"} ${duration(active.intervalMs)}: ${active.prompt}`,
    ...(active.reason ? [`Reason: ${active.reason}`] : []),
    `Runs: ${active.runs} of ${active.maxRuns}`,
    ...(active.nextAt ? [`Next run in ${duration(Math.max(0, active.nextAt - now))} (waits for the session to be idle).`] : []),
    "Stop it with /loop stop.",
  ].join("\n")
}

export * as SessionRepeat from "./repeat"
