import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, requestToolResults, runtimeEnv } from "./helpers"

// A local server that records every hit: the private-address protection must refuse a
// loopback fetch before any connection, so the hit counter proves whether one was made.
const serveHitCounter = () =>
  Effect.gen(function* () {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++
        return new Response("secret internal data", { headers: { "content-type": "text/plain" } })
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
    return { url: server.url.toString(), hits: () => hits }
  })

const pushWebfetchTurn = (llm: CliFixture["llm"], url: string) =>
  llm.push(reply().tool("webfetch", { url }), reply().text("done"))

describe("webfetch private-address protection (e2e)", () => {
  cliIt.live(
    "an allow rule plus a loopback URL is refused in an unattended run before connecting",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const target = yield* serveHitCounter()
        yield* pushWebfetchTurn(llm, target.url)

        const result = yield* opencode.run("fetch the internal page", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { permission: { webfetch: "allow" } }) },
        })

        if (process.env.QWEN_DBG) {
          const inputs = yield* llm.inputs
          console.error("DBG stdout:", JSON.stringify(result.stdout))
          console.error("DBG stderr:", JSON.stringify(result.stderr.slice(-1500)))
          console.error("DBG requests:", inputs.length)
          for (const [i, input] of inputs.entries()) {
            console.error(`DBG req${i} results:`, requestToolResults(input).join(" | ").slice(0, 400))
          }
        }
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("private or local network address")
        expect(target.hits()).toBe(0)

        // The model sees WHY the tool call failed in its next request.
        const inputs = yield* llm.inputs
        const last = inputs[inputs.length - 1]!
        expect(requestToolResults(last).join("\n")).toContain("refused before connecting")
      }),
    120_000,
  )

  cliIt.live(
    "webfetch.allow_private in global config fetches the loopback address",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { webfetch: { allow_private: true } })
        const target = yield* serveHitCounter()
        yield* pushWebfetchTurn(llm, target.url)

        const result = yield* opencode.run("fetch the internal page", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })

        expect(result.exitCode).toBe(0)
        expect(target.hits()).toBe(1)
      }),
    120_000,
  )

  cliIt.live(
    "webfetch.allow_private in project-level config does not disable the refusal",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const target = yield* serveHitCounter()
        yield* pushWebfetchTurn(llm, target.url)

        const result = yield* opencode.run("fetch the internal page", {
          env: {
            ...runtimeEnv(home),
            // YUKIOSHI_CONFIG_CONTENT is merged as project-level config (config.ts runs it
            // through projectConfig), so this is the project-config attempt.
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, {
              webfetch: { allow_private: true },
              permission: { webfetch: "allow" },
            }),
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("private or local network address")
        expect(target.hits()).toBe(0)
      }),
    120_000,
  )
})
