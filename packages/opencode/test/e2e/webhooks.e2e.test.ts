import { createHmac } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, runtimeEnv, waitFor } from "./helpers"

type Delivery = { body: string; signature: string | null }

function receiver(deliveries: Delivery[], response: () => Response | Promise<Response> = () => new Response("ok")) {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      deliveries.push({
        body: await request.text(),
        signature: request.headers.get("X-YukiOshi-Signature"),
      })
      return response()
    },
  })
}

describe("webhooks", () => {
  cliIt.live(
    "turn.finished has a valid HMAC and contains no message text or file contents",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const deliveries: Delivery[] = []
        const server = receiver(deliveries)
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        globalConfig(home, {
          webhooks: [{ url: server.url.toString(), secret: "e2e-signing-secret", events: ["turn.finished"] }],
        })
        yield* llm.text("assistant-private-marker-9401")
        const result = yield* opencode.run("user-private-marker-6712", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        yield* Effect.promise(() => waitFor(() => deliveries.length === 1, "turn.finished webhook was not received"))
        const delivery = deliveries[0]!
        const payload = JSON.parse(delivery.body) as Record<string, unknown>
        expect(payload.event).toBe("turn.finished")
        expect(payload).toHaveProperty("time")
        expect(payload).toHaveProperty("session")
        expect(payload).toHaveProperty("project")
        expect(delivery.body).not.toContain("user-private-marker-6712")
        expect(delivery.body).not.toContain("assistant-private-marker-9401")
        expect(delivery.body).not.toContain("file contents")
        expect(delivery.signature).toBe(
          `sha256=${createHmac("sha256", "e2e-signing-secret").update(delivery.body).digest("hex")}`,
        )
      }),
    60_000,
  )

  cliIt.live(
    "a failed turn sends turn.failed",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const deliveries: Delivery[] = []
        const server = receiver(deliveries)
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        globalConfig(home, { webhooks: [{ url: server.url.toString(), events: ["turn.failed"] }] })
        yield* llm.error(400, { error: { message: "deliberate e2e provider failure" } })
        const result = yield* opencode.run("fail this turn", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(1)
        yield* Effect.promise(() => waitFor(() => deliveries.length === 1, "turn.failed webhook was not received"))
        const payload = JSON.parse(deliveries[0]!.body) as { event: string; detail?: { error?: string } }
        expect(payload.event).toBe("turn.failed")
        expect(payload.detail?.error).toContain("deliberate e2e provider failure")
      }),
    60_000,
  )

  cliIt.live(
    'events ["turn.failed"] sends nothing for a successful turn',
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const deliveries: Delivery[] = []
        const server = receiver(deliveries)
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
        globalConfig(home, { webhooks: [{ url: server.url.toString(), events: ["turn.failed"] }] })
        yield* llm.text("success")
        const result = yield* opencode.run("finish successfully", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        yield* Effect.sleep("300 millis")
        expect(deliveries).toHaveLength(0)
      }),
    60_000,
  )

  cliIt.live(
    "a receiver that never answers adds less than about a second to CLI exit",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) }
        globalConfig(home, {})
        yield* llm.text("baseline")
        const baseline = yield* opencode.run("baseline turn", { env })
        expect(baseline.exitCode).toBe(0)

        const deliveries: Delivery[] = []
        const hanging = receiver(deliveries, () => new Promise<Response>(() => undefined))
        yield* Effect.addFinalizer(() => Effect.sync(() => hanging.stop(true)))
        globalConfig(home, { webhooks: [{ url: hanging.url.toString(), events: ["turn.finished"] }] })
        yield* llm.reset
        yield* llm.text("with webhook")
        const hooked = yield* opencode.run("turn with hanging webhook", { env })
        expect(hooked.exitCode).toBe(0)
        expect(hooked.durationMs).toBeLessThan(baseline.durationMs + 1_500)
        yield* Effect.promise(() => waitFor(() => deliveries.length === 1, "hanging receiver was never contacted"))
      }),
    60_000,
  )
})
