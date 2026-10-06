import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config } from "./helpers"

describe("loop", () => {
  cliIt.live("runs the configured loop twice and records its stop reason", ({ home, llm, opencode }) => Effect.gen(function* () {
    const server = yield* opencode.serve({
      env: { YUKIOSHI_CONFIG_CONTENT: config(llm.url, { loop: { enabled: true, max_runs: 2, min_interval: 1 } }) },
    })
    yield* llm.text("first run")
    yield* llm.text("second run")

    const created = yield* Effect.promise(() => fetch(`${server.url}/session`, { method: "POST" }))
    expect(created.ok).toBe(true)
    const session = (yield* Effect.promise(() => created.json())) as { id: string }
    const command = yield* Effect.promise(() => fetch(`${server.url}/session/${session.id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "loop", arguments: "1s check the work", model: "test/test-model" }),
    }))
    expect(command.ok).toBe(true)
    yield* llm.wait(2)

    const stopped = yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const status = await fetch(`${server.url}/session/${session.id}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "loop", arguments: "status", model: "test/test-model" }),
        })
        if (JSON.stringify(await status.json()).includes("Stopped after 2 runs")) return true
        await Bun.sleep(100)
      }
      return false
    })
    expect(stopped).toBe(true)
    const requests = yield* llm.inputs
    expect(requests.filter((request) => !JSON.stringify(request).includes("Generate a title for this conversation"))).toHaveLength(2)
  }), 60_000)
})
