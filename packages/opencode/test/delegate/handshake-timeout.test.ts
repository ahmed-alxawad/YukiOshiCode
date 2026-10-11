import { expect, test } from "bun:test"
import os from "node:os"
import { runDelegate } from "@/delegate/client"

// An agent that starts but never answers the ACP handshake must fail with a clear message and leave no process.
test("a silent agent fails the handshake within the limit", async () => {
  const started = Date.now()
  const error = await runDelegate({
    agentName: "silent",
    // Starts and then never reads or answers.
    agentConfig: { command: ["sh", "-c", "echo $$ >&2; sleep 300"], timeout: 60_000 },
    handshakeTimeoutMs: 1000,
    prompt: "hi",
    cwd: os.tmpdir(),
    abortSignal: new AbortController().signal,
    askPermission: async () => ({ outcome: "cancelled" }),
  }).then(
    () => undefined,
    (e: Error) => e,
  )
  expect(error?.message).toContain('Agent "silent"')
  expect(error?.message).toContain("did not answer the ACP handshake")
  // The handshake limit is not raised by the delegation timeout, so the message must not suggest that.
  expect(error?.message).not.toContain("delegate.agents.silent.timeout")
  expect(Date.now() - started).toBeLessThan(10_000)
}, 30_000)

// A timeout larger than a timer can hold must not make the delegation time out at once.
test("a delegation timeout above the timer limit does not fire immediately", async () => {
  const started = Date.now()
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 1500)
  const error = await runDelegate({
    agentName: "silent",
    agentConfig: { command: ["sh", "-c", "sleep 300"], timeout: 3_000_000_000 },
    handshakeTimeoutMs: 60_000,
    prompt: "hi",
    cwd: os.tmpdir(),
    abortSignal: abort.signal,
    askPermission: async () => ({ outcome: "cancelled" }),
  }).then(
    () => undefined,
    (e: Error) => e,
  )
  expect(error?.message).toContain("aborted")
  expect(error?.message).not.toContain("timed out")
  expect(Date.now() - started).toBeGreaterThan(1000)
}, 30_000)
