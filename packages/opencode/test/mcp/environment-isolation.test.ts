import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect } from "effect"
import { McpEnvironment } from "../../src/mcp/environment"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

const DEFAULT_SECRET = "YUKIOSHI_MCP_ENV_DEFAULT_TOKEN"
const DEFAULT_ORDINARY = "YUKIOSHI_MCP_ENV_DEFAULT_ORDINARY"
const EXPLICIT_SECRET = "YUKIOSHI_MCP_ENV_EXPLICIT_TOKEN"
const INHERITED_SECRET = "YUKIOSHI_MCP_ENV_INHERITED_TOKEN"
const INHERITED_ORDINARY = "YUKIOSHI_MCP_ENV_INHERITED_ORDINARY"
const SAFE_LOCALE = "LC_YUKIOSHI_MCP_ENV_TEST"
const SAFE_PATH = "/tmp/yukioshi-mcp-test-path"
const SAFE_TMPDIR = "/tmp/yukioshi-mcp-test-tmp"
const TRANSPORT_EXTRA = "LOGNAME"

const REPORTED_VARIABLES = [
  "PATH",
  "TMPDIR",
  SAFE_LOCALE,
  TRANSPORT_EXTRA,
  DEFAULT_SECRET,
  DEFAULT_ORDINARY,
  EXPLICIT_SECRET,
  INHERITED_SECRET,
  INHERITED_ORDINARY,
]

// This self-contained stdio server prints the environment it received and returns the same selected values in a tool description.
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

function withParentEnvironment<A, E, R>(values: Record<string, string>, use: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {}
      for (const [name, value] of Object.entries(values)) {
        previous[name] = process.env[name]
        process.env[name] = value
      }
      return previous
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
  )
}

function reportedEnvironment(mcp: MCPNS.Interface, name: string) {
  return Effect.gen(function* () {
    const tool = (yield* mcp.tools())[`${name}_environment`]
    expect(tool).toBeDefined()
    expect(tool!.def.description).toBeDefined()
    return JSON.parse(tool!.def.description!) as Record<string, string>
  })
}

function stdioConfig() {
  return {
    type: "local" as const,
    command: [process.execPath, "--eval", stdioEnvironmentStub],
  }
}

describe("mcp local stdio environment isolation", () => {
  it.effect("keeps standard proxy variables in the safe base environment", () =>
    Effect.sync(() => {
      const environment = McpEnvironment.local({}, { HTTP_PROXY: "http://proxy.example.test", SERVICE_TOKEN: "hidden" })
      expect(environment.HTTP_PROXY).toBe("http://proxy.example.test")
      expect(environment.SERVICE_TOKEN).toBeUndefined()
    }),
  )

  it.instance("does not inherit credential-like or unrelated parent variables by default", () =>
    withParentEnvironment(
      {
        [DEFAULT_SECRET]: "parent-secret",
        [DEFAULT_ORDINARY]: "parent-value",
        [SAFE_LOCALE]: "safe-locale",
        PATH: SAFE_PATH,
        TMPDIR: SAFE_TMPDIR,
        [TRANSPORT_EXTRA]: "not-safe",
      },
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("default-environment", stdioConfig())
        expect(result.status).toMatchObject({ "default-environment": { status: "connected" } })

        const environment = yield* reportedEnvironment(mcp, "default-environment")
        expect(environment[DEFAULT_SECRET]).toBeUndefined()
        expect(environment[DEFAULT_ORDINARY]).toBeUndefined()
        expect(environment[SAFE_LOCALE]).toBe("safe-locale")
        expect(environment[TRANSPORT_EXTRA]).toBeUndefined()
        expect(environment.PATH).toBe(SAFE_PATH)
        expect(environment.TMPDIR).toBe(SAFE_TMPDIR)
      }),
    ),
  )

  it.instance("passes a credential-like variable explicitly configured for the server", () =>
    withParentEnvironment(
      { [EXPLICIT_SECRET]: "parent-secret" },
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("explicit-environment", {
          ...stdioConfig(),
          environment: { [EXPLICIT_SECRET]: "configured-secret" },
        })
        expect(result.status).toMatchObject({ "explicit-environment": { status: "connected" } })

        const environment = yield* reportedEnvironment(mcp, "explicit-environment")
        expect(environment[EXPLICIT_SECRET]).toBe("configured-secret")
      }),
    ),
  )

  it.instance("inherits the complete parent environment only when inherit_env is enabled", () =>
    withParentEnvironment(
      {
        [INHERITED_SECRET]: "inherited-secret",
        [INHERITED_ORDINARY]: "inherited-value",
      },
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("inherited-environment", {
          ...stdioConfig(),
          inherit_env: true,
        })
        expect(result.status).toMatchObject({ "inherited-environment": { status: "connected" } })

        const environment = yield* reportedEnvironment(mcp, "inherited-environment")
        expect(environment[INHERITED_SECRET]).toBe("inherited-secret")
        expect(environment[INHERITED_ORDINARY]).toBe("inherited-value")
      }),
    ),
  )
})
