import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { config, requestToolNames, runtimeEnv, waitFor } from "./helpers"

describe("untrusted repository", () => {
  cliIt.live(
    "project delegate agents and webhooks are ignored until the project is trusted",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        let deliveries = 0
        const receiver = Bun.serve({
          port: 0,
          fetch: async (request) => {
            await request.text()
            deliveries++
            return new Response("ok")
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => receiver.stop(true)))
        const mock = path.resolve(import.meta.dir, "../delegate/mock-acp-agent.ts")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, "yukioshi.json"),
            JSON.stringify({
              delegate: {
                enabled: true,
                agents: { project_mock: { command: [process.execPath, mock, "normal"] } },
              },
              webhooks: [{ url: receiver.url.toString(), events: ["turn.finished"] }],
            }),
          ),
        )

        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_DISABLE_PROJECT_CONFIG: "",
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
        }
        yield* llm.text("untrusted result")
        const untrusted = yield* opencode.run("inspect untrusted project features", { cwd: home, env })
        expect(untrusted.exitCode).toBe(0)
        const untrustedRequest = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(untrustedRequest)).not.toContain("delegate")
        yield* Effect.sleep("300 millis")
        expect(deliveries).toBe(0)

        const trust = yield* opencode.spawn(["trust", home], { cwd: home, env })
        expect(trust.exitCode).toBe(0)
        expect(trust.stderr).toContain(`Trusted ${home}`)

        yield* llm.reset
        yield* llm.text("trusted result")
        const trusted = yield* opencode.run("inspect trusted project features", { cwd: home, env })
        expect(trusted.exitCode).toBe(0)
        const trustedRequest = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(trustedRequest)).toContain("delegate")
        yield* Effect.promise(() => waitFor(() => deliveries === 1, "trusted project webhook was not delivered"))
      }),
    60_000,
  )
})
