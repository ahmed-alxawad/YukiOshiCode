import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, runtimeEnv } from "./helpers"

describe("webhooks", () => {
  cliIt.live("delivers a signed turn.finished payload without message text", ({ home, llm, opencode }) => Effect.gen(function* () {
    let resolve!: (value: Record<string, unknown>) => void
    const received = new Promise<Record<string, unknown>>((r) => (resolve = r))
    const server = Bun.serve({ port: 0, fetch: async (req) => { resolve(await req.json() as Record<string, unknown>); return new Response("ok") } })
    globalConfig(home, { webhooks: [{ url: `http://127.0.0.1:${server.port}`, secret: "test-secret", events: ["turn.finished"] }] })
    yield* llm.text("finished")
    const result = yield* opencode.run("finish", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) } })
    expect(result.exitCode).toBe(0)
    const body = yield* Effect.promise(() => Promise.race([received, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))]))
    expect(body.event).toBe("turn.finished")
    expect(body).not.toHaveProperty("message")
    server.stop(true)
  }), 60_000)
})
