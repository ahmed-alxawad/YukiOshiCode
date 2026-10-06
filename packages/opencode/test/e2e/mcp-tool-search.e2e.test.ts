import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, requestToolNames, requestToolResults, runtimeEnv } from "./helpers"

const fixture = path.resolve(import.meta.dir, "fixture/mcp-tools.ts")

function configure(home: string) {
  globalConfig(home, {
    mcp: {
      fixture: { type: "local", command: [process.execPath, fixture], enabled: true },
    },
  })
}

function mcpTools(input: Record<string, unknown>) {
  return requestToolNames(input).filter((name) => name.startsWith("fixture_"))
}

describe("MCP tool search", () => {
  cliIt.live(
    "defers all MCP tools, loads only the selected tool, and calls it",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        configure(home)
        yield* llm.push(reply().tool("tool_search", { query: "select:fixture_tool_07" }))
        yield* llm.push(reply().tool("fixture_tool_07", { value: "chosen" }))
        yield* llm.text("mcp complete")
        const result = yield* opencode.run("load and call one MCP tool", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_search: { enabled: true } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const requests = (yield* llm.inputs).filter((input) => Array.isArray(input.tools))
        expect(requestToolNames(requests[0]!)).toContain("tool_search")
        expect(mcpTools(requests[0]!)).toEqual([])
        expect(mcpTools(requests[1]!)).toEqual(["fixture_tool_07"])
        expect(requestToolResults(requests.at(-1)!).at(-1)).toContain('mcp-result:tool_07:{"value":"chosen"}')
      }),
    60_000,
  )

  cliIt.live(
    "auto mode stays off below its threshold and turns on above it",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        configure(home)
        yield* llm.text("below")
        const below = yield* opencode.run("inspect below threshold", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, {
              tool_search: { enabled: "auto", threshold: 1_000_000 },
            }),
          },
        })
        expect(below.exitCode).toBe(0)
        let request = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(request)).not.toContain("tool_search")
        expect(mcpTools(request)).toHaveLength(40)

        yield* llm.reset
        yield* llm.text("above")
        const above = yield* opencode.run("inspect above threshold", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_search: { enabled: "auto", threshold: 1 } }),
          },
        })
        expect(above.exitCode).toBe(0)
        request = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(request)).toContain("tool_search")
        expect(mcpTools(request)).toEqual([])
      }),
    60_000,
  )

  cliIt.live(
    "calling a deferred tool before loading it tells the model to use tool_search",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        configure(home)
        yield* llm.push(reply().tool("fixture_tool_03", {}))
        yield* llm.text("recovered")
        const result = yield* opencode.run("call before loading", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_search: { enabled: true } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const output = requestToolResults((yield* llm.inputs).at(-1)!).at(-1)!
        expect(output).toContain('Tool "fixture_tool_03" is not loaded yet')
        expect(output).toContain('query "select:fixture_tool_03"')
      }),
    60_000,
  )
})
