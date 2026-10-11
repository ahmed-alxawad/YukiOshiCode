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
  expect(error?.message).toContain("delegate.agents.silent.timeout")
  expect(Date.now() - started).toBeLessThan(10_000)
}, 30_000)
