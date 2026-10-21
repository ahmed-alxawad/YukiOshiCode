import { expect, test } from "bun:test"
import { createMessageQueue, resolveMessageMode, toggleMessageMode } from "../../src/component/prompt/message-queue"

const tick = () => new Promise((r) => setTimeout(r, 0))

test("default message mode is queue; stored choice beats config; steer is opt-in", () => {
  expect(resolveMessageMode(undefined, undefined)).toBe("queue")
  expect(resolveMessageMode("bogus", undefined)).toBe("queue")
  expect(resolveMessageMode(undefined, "steer")).toBe("steer")
  expect(resolveMessageMode("queue", "steer")).toBe("queue")
  expect(resolveMessageMode("steer", "queue")).toBe("steer")
  expect(toggleMessageMode("queue")).toBe("steer")
  expect(toggleMessageMode("steer")).toBe("queue")
})

test("steer mode never holds; queue mode holds while busy", () => {
  const q = createMessageQueue()
  expect(q.shouldHold("steer", true, "s")).toBe(false)
  expect(q.shouldHold("queue", true, "s")).toBe(true)
  expect(q.shouldHold("queue", false, "s")).toBe(false)
})

test("queue holds messages, then sends them one by one in order after idle", async () => {
  const q = createMessageQueue()
  const sent: string[] = []
  q.add("s", "a", () => void sent.push("a"))
  q.add("s", "b", () => void sent.push("b"))
  expect(q.held("s").map((x) => x.text)).toEqual(["a", "b"])
  q.pump("s", false)
  expect(sent).toEqual([])
  q.pump("s", true)
  expect(sent).toEqual(["a"])
  expect(q.held("s").map((x) => x.text)).toEqual(["b"])
  q.pump("s", true) // still waiting for a's turn to start
  expect(sent).toEqual(["a"])
  q.pump("s", false) // a's turn started
  q.pump("s", true) // a's turn finished
  expect(sent).toEqual(["a", "b"])
  expect(q.held("s")).toEqual([])
})

test("an abort (busy to idle) keeps held messages and sends them afterwards", () => {
  const q = createMessageQueue()
  const sent: string[] = []
  q.pump("s", false)
  q.add("s", "a", () => void sent.push("a"))
  expect(q.held("s").length).toBe(1)
  expect(sent).toEqual([])
  q.pump("s", true)
  expect(sent).toEqual(["a"])
})

test("a failed send frees the queue for the next message; clear discards", async () => {
  const q = createMessageQueue()
  const sent: string[] = []
  q.add("s", "a", () => Promise.reject(new Error("x")))
  q.add("s", "b", () => void sent.push("b"))
  q.pump("s", true)
  await tick()
  expect(sent).toEqual(["b"])
  q.add("s", "c", () => void sent.push("c"))
  q.clear()
  expect(q.size("s")).toBe(0)
  expect(q.held("s")).toEqual([])
})

test("a held message that never starts a turn does not freeze the queue", async () => {
  const q = createMessageQueue({ noTurnGraceMs: 5 })
  const sent: string[] = []
  q.add("s", "/loop status", () => void sent.push("/loop status"))
  q.add("s", "fix the tests", () => void sent.push("fix the tests"))
  q.pump("s", true)
  expect(sent).toEqual(["/loop status"])
  // The command is answered directly: no busy status arrives.
  await new Promise((r) => setTimeout(r, 30))
  expect(sent).toEqual(["/loop status", "fix the tests"])
  // Nothing is stuck: a new message is not held once the session is idle.
  expect(q.shouldHold("queue", false, "s")).toBe(false)
})

test("a turn that starts within the grace period is waited for as before", async () => {
  const q = createMessageQueue({ noTurnGraceMs: 20 })
  const sent: string[] = []
  q.add("s", "a", () => void sent.push("a"))
  q.add("s", "b", () => void sent.push("b"))
  q.pump("s", true)
  await tick()
  q.pump("s", false) // a's turn started
  await new Promise((r) => setTimeout(r, 40))
  expect(sent).toEqual(["a"]) // still running: b waits
  q.pump("s", true)
  expect(sent).toEqual(["a", "b"])
})
