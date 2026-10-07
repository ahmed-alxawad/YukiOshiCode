import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { config, requestText, requestToolNames, runtimeEnv } from "./helpers"

describe("web search and code navigation settings", () => {
  cliIt.live(
    "websearch and lsp are only offered when their settings turn them on",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const tools = (marker: string, extra: Record<string, unknown>) =>
          Effect.gen(function* () {
            yield* llm.text("nothing to do")
            const result = yield* opencode.run(marker, {
              env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, extra) },
            })
            expect(result.exitCode).toBe(0)
            return requestToolNames((yield* llm.inputs).find((input) => requestText(input).includes(marker))!)
          })

        const off = yield* tools("DEFAULTS", {})
        expect(off).toContain("read")
        expect(off).not.toContain("websearch")
        expect(off).not.toContain("lsp")

        const on = yield* tools("BOTH-ON", { web_search: { enabled: true }, lsp: true, lsp_tool: true })
        expect(on).toContain("websearch")
        expect(on).toContain("lsp")

        // The lsp tool needs language servers; without them it would only ever fail.
        const noServers = yield* tools("NO-SERVERS", { lsp_tool: true })
        expect(noServers).not.toContain("lsp")
      }),
    120_000,
  )
})
