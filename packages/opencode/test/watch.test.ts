import { expect, test } from "bun:test"
import {
  commentLines,
  fatalWatcherStop,
  findTriggers,
  markTaskFailed,
  queueTriggers,
  removeMarker,
  retryCooldownMs,
  setRetryBaseMsForTest,
  shouldRunTask,
  triggerKey,
  watchRootLostMessage,
  watchScanErrorMessage,
  watchStopMessage,
  WATCH_RETRY_BASE_MS,
  type TaskLog,
} from "../src/watch"

test("detects every comment style and ignores code", () => {
  const src = ["// a AI!", "# b AI?", "-- c AI!", "/* d AI! */", "<!-- e AI? -->", "const x = 1 // f AI!", "// plain", "// notAI!"].join("\n")
  expect(findTriggers(src).map((t) => [t.line, t.kind, t.text])).toEqual([
    [1, "do", "a"], [2, "ask", "b"], [3, "do", "c"], [4, "do", "d"], [5, "ask", "e"],
  ])
})

test("removes the marker and writes the answer below in the same style", () => {
  const [t] = findTriggers("  /* why? AI? */\nx")
  expect(removeMarker("  /* why? AI? */\nx", t, "because")).toBe("  /* why? */\n  /* because */\nx")
  expect(commentLines("# q AI?", "a\nb")).toEqual(["# a", "# b"])
})

test("a marker's task key ignores indentation and line shifts", () => {
  const plain = findTriggers("// fix the parser AI!\n")[0]
  const indented = findTriggers("    // fix the parser AI!\n")[0]
  const shifted = findTriggers("const x = 1\n// fix the parser AI! \n")[0]
  expect(triggerKey("note.js", plain)).toBe(triggerKey("note.js", indented))
  expect(triggerKey("note.js", plain)).toBe(triggerKey("note.js", shifted))
  expect(triggerKey("note.js", plain)).not.toBe(triggerKey("other.js", plain))
  expect(triggerKey("note.js", plain)).not.toBe(triggerKey("note.js", findTriggers("// fix the parser AI?")[0]))
})

test("indentation churn does not re-run a marker task", () => {
  const log: TaskLog = new Map()
  const original = findTriggers("// fix the parser AI!\n")
  const indented = findTriggers("  // fix the parser AI!\n")
  const shifted = findTriggers("const x = 1\n// fix the parser AI! \n")
  expect(queueTriggers(log, "note.js", original, 1000)).toHaveLength(1)
  expect(queueTriggers(log, "note.js", indented, 2000)).toHaveLength(0)
  expect(queueTriggers(log, "note.js", shifted, 3000)).toHaveLength(0)
})

test("the same marker text twice in one file dedupes to one task", () => {
  const log: TaskLog = new Map()
  const both = findTriggers("// fix a AI!\nconst x = 1\n// fix a AI!\n")
  expect(both).toHaveLength(2)
  expect(queueTriggers(log, "a.ts", both, 1000)).toHaveLength(1)
  expect(queueTriggers(log, "a.ts", both, 2000)).toHaveLength(0)
  expect(queueTriggers(log, "a.ts", [...both, ...findTriggers("// fix b AI!\n")], 3000)).toHaveLength(1)
})

test("a run that removed the marker lets the same task run again later", () => {
  const log: TaskLog = new Map()
  const trigger = findTriggers("// fix a AI!\n")[0]
  const key = triggerKey("a.ts", trigger)
  expect(queueTriggers(log, "a.ts", [trigger], 1000)).toHaveLength(1)
  log.delete(key) // success: removeMarker rewrote the file, so the loop forgets the key
  expect(queueTriggers(log, "a.ts", [trigger], 2000)).toHaveLength(1)
})

test("a marker left in place keeps its key so the task never loops", () => {
  const log: TaskLog = new Map()
  const trigger = findTriggers("// fix a AI!\n")[0]
  const key = triggerKey("a.ts", trigger)
  expect(queueTriggers(log, "a.ts", [trigger], 1000)).toHaveLength(1)
  // dry-run or "changed during the run": the record stays done and is never requeued.
  expect(queueTriggers(log, "a.ts", [trigger], 3_600_000)).toHaveLength(0)
  expect(log.get(key)?.status).toBe("done")
})

test("a failed task requeues on the next scan when the cooldown is zero", () => {
  const previous = setRetryBaseMsForTest(0)
  try {
    const log: TaskLog = new Map()
    const trigger = findTriggers("// fix a AI!\n")[0]
    const key = triggerKey("a.ts", trigger)
    expect(queueTriggers(log, "a.ts", [trigger], 1000)).toHaveLength(1)
    expect(markTaskFailed(log, key, 1000)).toBe(false)
    expect(queueTriggers(log, "a.ts", [trigger], 1001)).toHaveLength(1)
  } finally {
    setRetryBaseMsForTest(previous)
  }
})

test("a failed task waits out its exponential backoff before requeueing", () => {
  const log: TaskLog = new Map()
  const base = WATCH_RETRY_BASE_MS
  const trigger = findTriggers("// fix a AI!\n")[0]
  const key = triggerKey("a.ts", trigger)
  expect(queueTriggers(log, "a.ts", [trigger], 0)).toHaveLength(1)
  expect(markTaskFailed(log, key, 1000)).toBe(false)
  expect(shouldRunTask(log, key, 1000 + base - 1)).toBe(false)
  expect(shouldRunTask(log, key, 1000 + base)).toBe(true)
  expect(markTaskFailed(log, key, 2000)).toBe(false)
  expect(shouldRunTask(log, key, 2000 + base)).toBe(false)
  expect(shouldRunTask(log, key, 2000 + 2 * base)).toBe(true)
  expect(retryCooldownMs(1)).toBe(base)
  expect(retryCooldownMs(2)).toBe(2 * base)
  expect(retryCooldownMs(3)).toBe(4 * base)
})

test("a task is given up after exactly three failed attempts", () => {
  const log: TaskLog = new Map()
  const base = WATCH_RETRY_BASE_MS
  const trigger = findTriggers("// fix a AI!\n")[0]
  const key = triggerKey("a.ts", trigger)
  expect(queueTriggers(log, "a.ts", [trigger], 0)).toHaveLength(1)
  expect(markTaskFailed(log, key, 1000)).toBe(false)
  expect(queueTriggers(log, "a.ts", [trigger], 1000 + base)).toHaveLength(1)
  expect(markTaskFailed(log, key, 2000)).toBe(false)
  expect(queueTriggers(log, "a.ts", [trigger], 2000 + 2 * base)).toHaveLength(1)
  expect(markTaskFailed(log, key, 3000)).toBe(true) // third strike: the loop prints the giving-up line
  expect(queueTriggers(log, "a.ts", [trigger], 3000 + 100 * base)).toHaveLength(0)
  expect(shouldRunTask(log, key, Number.MAX_SAFE_INTEGER)).toBe(false)
})

test("success clears the failure count", () => {
  const log: TaskLog = new Map()
  const trigger = findTriggers("// fix a AI!\n")[0]
  const key = triggerKey("a.ts", trigger)
  queueTriggers(log, "a.ts", [trigger], 0)
  markTaskFailed(log, key, 1000)
  markTaskFailed(log, key, 2000)
  log.delete(key) // the third attempt succeeded and removed the marker
  queueTriggers(log, "a.ts", [trigger], 3000)
  expect(markTaskFailed(log, key, 4000)).toBe(false) // a fresh failure is only attempt one again
  expect(log.get(key)).toEqual({ status: "failed", failures: 1, lastFailedAt: 4000 })
})

test("watcher fatal messages keep the watch/…/stopping shape", () => {
  expect(watchStopMessage(new Error("EPERM: watch failed"))).toBe("watch: EPERM: watch failed; stopping")
  expect(watchStopMessage("boom")).toBe("watch: boom; stopping")
  expect(watchRootLostMessage("/repo/sub")).toBe("watch: /repo/sub was removed or renamed; stopping")
  expect(watchScanErrorMessage("a.ts", new Error("no space left"))).toBe("watch: scan of a.ts failed: no space left")
})

test("fatalWatcherStop prints the reason, sets a non-zero exit, and stops the loop", () => {
  const previous = process.exitCode
  const printed: string[] = []
  let stopped = 0
  try {
    fatalWatcherStop("watch: /repo/sub was removed or renamed; stopping", (line) => printed.push(line), () => stopped++)
    expect(printed).toEqual(["watch: /repo/sub was removed or renamed; stopping"])
    expect(process.exitCode).toBe(1)
    expect(stopped).toBe(1)
  } finally {
    // Bun 1.3.14's runner exits 1 when this test restores exitCode with `undefined`, so restore a concrete value.
    process.exitCode = previous ?? 0
  }
})
