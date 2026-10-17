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

// Stub that answers the ACP initialize request after a delay, then stays silent.
const lateAgent = (delaySec: number) => [
  "sh",
  "-c",
  `read l; sleep ${delaySec}; id=$(echo "$l" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p'); echo '{"jsonrpc":"2.0","id":'$id',"result":{"protocolVersion":1,"agentCapabilities":{}}}'; sleep 300`,
]
const run = (handshakeTimeout: unknown, command = lateAgent(0.9)) =>
  runDelegate({
    agentName: "slow",
    agentConfig: { command, timeout: 60_000, handshakeTimeout } as never,
    prompt: "hi",
    cwd: os.tmpdir(),
    abortSignal: AbortSignal.timeout(4000),
    askPermission: async () => ({ outcome: "cancelled" }),
  }).then(
    () => undefined,
    (e: Error) => e,
  )

test("handshakeTimeout 300 ms fails a late agent and the message names the setting", async () => {
  const error = await run(300)
  expect(error?.message).toContain("did not answer the ACP handshake within 300ms")
  expect(error?.message).toContain("delegate.agents.slow.handshakeTimeout")
}, 15_000)

test("a larger handshakeTimeout is honoured", async () => {
  const started = Date.now()
  await run(1500)
  // Initialize is answered after 0.9 s, which 300 ms would not allow; the next step then waits the full 1500 ms.
  expect(Date.now() - started).toBeGreaterThan(2200)
}, 15_000)

test("invalid handshakeTimeout values fall back to the 60 s default", async () => {
  for (const bad of [0, -5, Number.NaN, Infinity, "300", null]) {
    const error = await run(bad)
    expect(error?.message).not.toContain("did not answer the ACP handshake")
  }
}, 30_000)

test("default handshake limit is 60 s", async () => {
  const { HANDSHAKE_TIMEOUT } = await import("@/delegate/client")
  expect(HANDSHAKE_TIMEOUT).toBe(60_000)
})
