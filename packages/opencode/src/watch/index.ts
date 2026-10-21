// Watch mode: comment lines ending in `AI!` (do it) or `AI?` (answer) become runs.
// Helpers live here so the command stays small and the parsing is testable; all are pure except gitIgnored.

export type Kind = "do" | "ask"
export type Trigger = { line: number; kind: Kind; text: string; raw: string }

const OPEN = /^(\s*)(\/\/+|#+|--+|\/\*+|<!--)\s?(.*)$/
const CLOSE = /\s*(\*\/|-->)\s*$/

const MARKUP = new Set([".md", ".mdx", ".markdown"])
const PROSE = new Set([".txt", ".rst", ".adoc", ".org"])

/** Markdown headings (`# What is AI?`) are not comments: markup files only take html comments, prose files none. */
function allowsOpener(file: string | undefined, open: string): boolean {
  const dot = file?.lastIndexOf(".") ?? -1
  const ext = file && dot >= 0 ? file.slice(dot).toLowerCase() : ""
  if (PROSE.has(ext)) return false
  if (MARKUP.has(ext)) return open === "<!--"
  return true
}

/** Comment-only lines (slash-slash, hash, double dash, c-style block, html comment) whose text ends in AI! or AI?. `file` (optional) limits the comment syntax by extension. */
export function findTriggers(content: string, file?: string): Trigger[] {
  const result: Trigger[] = []
  content.split("\n").forEach((line, index) => {
    const raw = line.replace(/\r$/, "")
    const match = OPEN.exec(raw)
    if (!match || !allowsOpener(file, match[2])) return
    const body = match[3].replace(CLOSE, "").trimEnd()
    const marker = /(?:^|\s)AI([!?])$/.exec(body)
    if (!marker) return
    const text = body.replace(/\s*AI[!?]$/, "").trim()
    result.push({ line: index + 1, kind: marker[1] === "!" ? "do" : "ask", text, raw })
  })
  return result
}

/** Removes the trailing marker from the line that still holds `raw` (the file may have shifted during the run). */
export function removeMarker(content: string, trigger: Trigger, answer?: string): string | undefined {
  const lines = content.split("\n")
  const stripped = trigger.raw.replace(/\s*AI[!?](\s*(\*\/|-->))?\s*$/, (_m, close) => (close ? " " + close.trim() : ""))
  const near = [trigger.line - 1, ...lines.keys()]
  const index = near.find((i) => lines[i].replace(/\r$/, "") === trigger.raw)
  if (index === undefined) return undefined
  const cr = lines[index].endsWith("\r") ? "\r" : ""
  lines[index] = stripped.trimEnd() + cr
  if (answer) lines.splice(index + 1, 0, ...commentLines(trigger.raw, answer).map((l) => l + cr))
  return lines.join("\n")
}

/** Answer text as comment lines in the same style and indentation as the trigger line. */
export function commentLines(raw: string, answer: string): string[] {
  const match = OPEN.exec(raw)!
  const indent = match[1]
  const open = match[2]
  const style = open.startsWith("/*") ? ["/* ", " */"] : open === "<!--" ? ["<!-- ", " -->"] : [open + " ", ""]
  return answer
    .trim()
    .split("\n")
    .map((line) => line.trimEnd().replace(/\s*AI[!?]$/, "").replaceAll("*/", "* /").replaceAll("-->", "-- >"))
    .map((line) => `${indent}${style[0]}${line}${style[1]}`.trimEnd())
}

export function promptFor(file: string, trigger: Trigger) {
  if (trigger.kind === "ask")
    return `A comment in ${file} at line ${trigger.line} asks a question: "${trigger.text}". Read the file and answer it briefly in plain text. Do not modify any files; the answer will be written as a comment below the question.`
  return `A comment in ${file} at line ${trigger.line} asks for a change: "${trigger.text}". Make that change in the repository. Leave the comment line itself alone; it is cleaned up afterwards.`
}

// --- Task bookkeeping: dedupe, retry, and fatal-stop decisions for the watch loop. ---

/** Cooldown before a failed marker task is retried, doubled per consecutive failure. */
export let WATCH_RETRY_BASE_MS = 30_000

/** Tests only: sets WATCH_RETRY_BASE_MS (to 0, say); returns the previous value so callers can restore it. */
export function setRetryBaseMsForTest(ms: number): number {
  const previous = WATCH_RETRY_BASE_MS
  WATCH_RETRY_BASE_MS = ms
  return previous
}

/** Consecutive failed attempts after which a marker task is abandoned (until its text changes). */
export const WATCH_MAX_ATTEMPTS = 3

export type TaskRecord = {
  /** `done`: queued, running, or finished with the marker kept — never requeue. `failed`: retry once the cooldown has elapsed. */
  status: "done" | "failed"
  /** Consecutive failed attempts so far; survives requeueing. */
  failures: number
  /** When the last attempt failed; 0 while the task is queued or running. */
  lastFailedAt: number
}

/** Watch-loop state per marker task, keyed by triggerKey. */
export type TaskLog = Map<string, TaskRecord>

/** Identity of a marker task: file plus logical text. Raw bytes and line numbers are noise, so re-indenting a marker never re-runs it. */
export function triggerKey(rel: string, trigger: Pick<Trigger, "kind" | "text">): string {
  return `${rel}:${trigger.kind}:${trigger.text}`
}

/** Wait before a task that failed `failures` consecutive times is retried again. */
export function retryCooldownMs(failures: number): number {
  return WATCH_RETRY_BASE_MS * 2 ** (failures - 1)
}

/** True when `key` never ran, or the backoff after its last failure has elapsed. Dead tasks (max attempts reached) never requeue. */
export function shouldRunTask(log: TaskLog, key: string, now: number): boolean {
  const record = log.get(key)
  if (!record) return true
  if (record.status !== "failed") return false
  if (record.failures >= WATCH_MAX_ATTEMPTS) return false
  return now - record.lastFailedAt >= retryCooldownMs(record.failures)
}

/** Reserves `key` for the queued run so repeated scans of the same marker do not queue it twice. */
export function reserveTask(log: TaskLog, key: string): void {
  log.set(key, { status: "done", failures: log.get(key)?.failures ?? 0, lastFailedAt: 0 })
}

/** The triggers of one file that should run now: new tasks plus failed tasks whose backoff has elapsed. Reserves each before returning. */
export function queueTriggers(log: TaskLog, rel: string, triggers: Trigger[], now: number): Trigger[] {
  const queued: Trigger[] = []
  for (const trigger of triggers) {
    const key = triggerKey(rel, trigger)
    if (!shouldRunTask(log, key, now)) continue
    reserveTask(log, key)
    queued.push(trigger)
  }
  return queued
}

/** Records a failed attempt. Returns true when the task just ran out of attempts — print the giving-up line once. */
export function markTaskFailed(log: TaskLog, key: string, now: number): boolean {
  const failures = (log.get(key)?.failures ?? 0) + 1
  log.set(key, { status: "failed", failures, lastFailedAt: now })
  return failures >= WATCH_MAX_ATTEMPTS
}

/** A watcher error (fs.watch gave up): print it and stop instead of going silent. */
export function watchStopMessage(error: unknown): string {
  return `watch: ${error instanceof Error ? error.message : String(error)}; stopping`
}

/** The watch root itself was removed or renamed (branch switch, rm -rf); the watcher can never fire again. */
export function watchRootLostMessage(dir: string): string {
  return `watch: ${dir} was removed or renamed; stopping`
}

/** A scan of one file failed; log one line instead of swallowing it. */
export function watchScanErrorMessage(rel: string, error: unknown): string {
  return `watch: scan of ${rel} failed: ${error instanceof Error ? error.message : String(error)}`
}

/** The one loud stop for a dead watcher: print the reason, flag a non-zero exit, and end the loop. */
export function fatalWatcherStop(message: string, print: (line: string) => void, stop: () => void): void {
  print(message)
  process.exitCode = 1
  stop()
}

/** Most paths sent to one `git check-ignore` process. */
export const IGNORE_CHECK_CHUNK = 1000

/**
 * The subset of `rels` (paths relative to `root`) that git ignores, from one `git check-ignore --stdin -z` call.
 * A git failure (exit other than 0 or 1) counts as nothing ignored, as the single-path check did.
 */
export async function gitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  if (!rels.length) return new Set()
  // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
  const safe = (rel: string) => (rel.startsWith(":") ? `./${rel}` : rel)
  const proc = Bun.spawn(["git", "check-ignore", "--stdin", "-z"], {
    cwd: root,
    stdin: new Blob([rels.map((rel) => safe(rel) + "\0").join("")]),
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0 && code !== 1) return new Set()
  const echoed = new Set(out.split("\0").filter(Boolean))
  return new Set(rels.filter((rel) => echoed.has(safe(rel))))
}

/**
 * Wraps a many-path ignore check so single-path calls made within `windowMs` of each other share one call per
 * `chunk` paths. A branch switch fires thousands of scans at once; this keeps it to a few git processes.
 */
export function batchIgnoreCheck(
  check: (rels: string[]) => Promise<Set<string>>,
  windowMs = 20,
  chunk = IGNORE_CHECK_CHUNK,
): (rel: string) => Promise<boolean> {
  let pending: { rel: string; resolve: (ignored: boolean) => void; reject: (error: unknown) => void }[] = []
  const flush = () => {
    const batch = pending
    pending = []
    for (let start = 0; start < batch.length; start += chunk) {
      const slice = batch.slice(start, start + chunk)
      check([...new Set(slice.map((item) => item.rel))]).then(
        (ignored) => slice.forEach((item) => item.resolve(ignored.has(item.rel))),
        (error) => slice.forEach((item) => item.reject(error)),
      )
    }
  }
  return (rel) =>
    new Promise((resolve, reject) => {
      if (!pending.length) setTimeout(flush, windowMs)
      pending.push({ rel, resolve, reject })
    })
}

/** SIGINT/SIGTERM: kill the in-flight run, drop what is still queued, and end the loop. */
export function stopRun(current: { kill: () => void } | undefined, queue: unknown[], finish: () => void): void {
  current?.kill()
  queue.length = 0
  finish()
}
