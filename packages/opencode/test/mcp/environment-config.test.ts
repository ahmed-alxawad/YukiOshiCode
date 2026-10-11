import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ConfigV1 } from "@yukioshi/core/v1/config/config"
import { ConfigMCPV1 } from "@yukioshi/core/v1/config/mcp"
import { Effect, Schema } from "effect"
import { ConfigVariable } from "../../src/config/variable"
import { MCP, type MCP as MCPNS } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

const CANONICAL_TOKEN = "YUKIOSHI_MCP_ENV_CANONICAL_TOKEN"
const ALIAS_TOKEN = "YUKIOSHI_MCP_ENV_ALIAS_TOKEN"
const SUBSTITUTED_TOKEN = "YUKIOSHI_MCP_ENV_SUBSTITUTED_TOKEN"
const CONFIG_SOURCE_TOKEN = "YUKIOSHI_MCP_ENV_CONFIG_SOURCE_TOKEN"
const REPORTED_VARIABLES = [CANONICAL_TOKEN, ALIAS_TOKEN, SUBSTITUTED_TOKEN]

// This self-contained stdio server reports its received environment through a tool description.
const stdioEnvironmentStub = [
  `const names = ${JSON.stringify(REPORTED_VARIABLES)}`,
  "const environment = Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))",
  "console.error(JSON.stringify({ receivedEnvironment: environment }))",
  'let buffer = ""',
  "for await (const chunk of process.stdin) {",
  "  buffer += chunk",
  '  while (buffer.includes("\\n")) {',
  '    const index = buffer.indexOf("\\n")',
  "    const line = buffer.slice(0, index)",
  "    buffer = buffer.slice(index + 1)",
  "    if (!line) continue",
  "    const message = JSON.parse(line)",
  "    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
  "    if (message.method === 'initialize') {",
  "      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'environment', version: '1.0.0' } })",
  "    }",
  "    if (message.method === 'tools/list') {",
  "      reply({ tools: [{ name: 'environment', description: JSON.stringify(environment), inputSchema: { type: 'object', properties: {} } }] })",
  "    }",
  "  }",
  "}",
].join("\n")

function localConfig() {
  return { type: "local" as const, command: [process.execPath, "--eval", stdioEnvironmentStub] }
}

function decodedServer(input: unknown, name: string): ConfigMCPV1.Info {
  const server = Schema.decodeUnknownSync(ConfigV1.Info)(input).mcp?.[name]
  if (!server || !("type" in server)) throw new Error(`missing local MCP server ${name}`)
  return server
}

function reportedEnvironment(mcp: MCPNS.Interface, name: string) {
  return Effect.gen(function* () {
    const tool = (yield* mcp.tools())[`${name}_environment`]
    expect(tool).toBeDefined()
    expect(tool!.def.description).toBeDefined()
    return JSON.parse(tool!.def.description!) as Record<string, string>
  })
}

describe("local MCP environment configuration", () => {
  it.instance("passes both environment aliases after config decoding", () =>
    Effect.gen(function* () {
      const canonical = decodedServer(
        { mcp: { canonical: { ...localConfig(), environment: { [CANONICAL_TOKEN]: "canonical" } } } },
        "canonical",
      )
      const alias = decodedServer({ mcp: { alias: { ...localConfig(), env: { [ALIAS_TOKEN]: "alias" } } } }, "alias")
      const mcp = yield* MCP.Service

      yield* mcp.add("canonical", canonical)
      yield* mcp.add("alias", alias)

      expect(yield* reportedEnvironment(mcp, "canonical")).toEqual({ [CANONICAL_TOKEN]: "canonical" })
      expect(yield* reportedEnvironment(mcp, "alias")).toEqual({ [ALIAS_TOKEN]: "alias" })
    }),
  )

  it.instance("passes a normally substituted config variable explicitly", () =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({
          type: "virtual",
          source: "test:mcp-environment",
          dir: process.cwd(),
          env: { [CONFIG_SOURCE_TOKEN]: "substituted" },
          text: JSON.stringify({
            mcp: {
              substituted: {
                ...localConfig(),
                env: { [SUBSTITUTED_TOKEN]: `{env:${CONFIG_SOURCE_TOKEN}}` },
              },
            },
          }),
        }),
      )
      const server = decodedServer(JSON.parse(expanded), "substituted")
      const mcp = yield* MCP.Service

      yield* mcp.add("substituted", server)

      expect(yield* reportedEnvironment(mcp, "substituted")).toEqual({ [SUBSTITUTED_TOKEN]: "substituted" })
    }),
  )
})
