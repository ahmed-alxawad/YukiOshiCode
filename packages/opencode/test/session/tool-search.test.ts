import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@yukioshi/core/model"
import { ProviderV2 } from "@yukioshi/core/provider"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Hooks } from "@/hooks"
import { Config } from "@/config/config"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import {
  calculateMcpDefinitionsSize,
  executeToolSearch,
  formatToolSearchDescription,
  isSearchMode,
  loadedToolsFromHistory,
  parseSelectQuery,
  rankDeferredTools,
  type DeferredTool,
} from "@/session/tool-search"

describe("tool-search ranking and select parsing", () => {
  const sampleTools: DeferredTool[] = [
    {
      name: "weather_get_current",
      description: "Get the current weather forecast for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
    {
      name: "weather_get_alerts",
      description: "Get active weather alerts and warnings",
      inputSchema: { type: "object", properties: { region: { type: "string" } } },
    },
    {
      name: "sql_database_query",
      description: "Execute SQL queries against the analytical database",
      inputSchema: { type: "object", properties: { sql: { type: "string" } } },
    },
    {
      name: "github_create_issue",
      description: "Create an issue in a GitHub repository",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
    {
      name: "calculator_add",
      description: "Add two numbers together",
      inputSchema: { type: "object" },
    },
    {
      name: "calculator_multiply",
      description: "Multiply two numbers together",
      inputSchema: { type: "object" },
    },
  ]

  test("ranks exact and prefix name matches higher than description matches", () => {
    const results = rankDeferredTools(sampleTools, "weather")
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0].name.startsWith("weather")).toBe(true)
    expect(results[1].name.startsWith("weather")).toBe(true)
  })

  test("ranks multi-word queries with all-words bonus", () => {
    const results = rankDeferredTools(sampleTools, "sql database")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].name).toBe("sql_database_query")
  })

  test("matches tools from description keywords", () => {
    const results = rankDeferredTools(sampleTools, "forecast")
    expect(results.length).toBe(1)
    expect(results[0].name).toBe("weather_get_current")
  })

  test("returns empty array for non-matching queries or empty string", () => {
    expect(rankDeferredTools(sampleTools, "nonexistentxyz123")).toEqual([])
    expect(rankDeferredTools(sampleTools, "")).toEqual([])
    expect(rankDeferredTools(sampleTools, "   ")).toEqual([])
  })

  test("caps results to limit (default 5, max 10)", () => {
    const manyTools: DeferredTool[] = Array.from({ length: 15 }, (_, i) => ({
      name: `tool_service_${i}`,
      description: `Service tool number ${i}`,
      inputSchema: {},
    }))
    const defaultRanked = rankDeferredTools(manyTools, "service")
    expect(defaultRanked.length).toBe(5)

    const rankedWithLimit = rankDeferredTools(manyTools, "service", 8)
    expect(rankedWithLimit.length).toBe(8)

    const cappedRanked = rankDeferredTools(manyTools, "service", 20)
    expect(cappedRanked.length).toBe(10)
  })

  test("parses 'select:' queries correctly", () => {
    expect(parseSelectQuery("select:weather_get_current")).toEqual(["weather_get_current"])
    expect(parseSelectQuery("select: weather_get_current, sql_database_query ")).toEqual([
      "weather_get_current",
      "sql_database_query",
    ])
    expect(parseSelectQuery("select:")).toEqual([])
    expect(parseSelectQuery("select:   ")).toEqual([])
    expect(parseSelectQuery("SELECT:tool1,tool2")).toEqual(["tool1", "tool2"])
    expect(parseSelectQuery("weather query")).toBeNull()
  })

  test("executeToolSearch selects tools in requested order and deduplicates", () => {
    const results = executeToolSearch(sampleTools, "select:sql_database_query, weather_get_current, sql_database_query")
    expect(results.map((t) => t.name)).toEqual(["sql_database_query", "weather_get_current"])
  })

  test("formatToolSearchDescription truncates descriptions to <=80 chars", () => {
    const longTool: DeferredTool = {
      name: "very_long_tool",
      description:
        "This is an extremely long tool description that clearly exceeds eighty characters in total length and needs truncation.",
      inputSchema: {},
    }
    const formatted = formatToolSearchDescription([longTool])
    const line = formatted.split("\n").find((l) => l.startsWith("- very_long_tool"))
    expect(line).toBeDefined()
    const descPart = line!.replace("- very_long_tool: ", "")
    expect(descPart.length).toBeLessThanOrEqual(80)
    expect(descPart.endsWith("...")).toBe(true)
  })
})

describe("tool-search threshold and auto decision", () => {
  test("isSearchMode correctly evaluates enabled=auto with threshold", () => {
    // Default threshold is 20000
    expect(isSearchMode(undefined, 15000)).toBe(false)
    expect(isSearchMode(undefined, 20000)).toBe(false)
    expect(isSearchMode(undefined, 20001)).toBe(true)

    expect(isSearchMode({ enabled: "auto" }, 10000)).toBe(false)
    expect(isSearchMode({ enabled: "auto" }, 25000)).toBe(true)

    // Custom threshold
    expect(isSearchMode({ enabled: "auto", threshold: 5000 as any }, 5000)).toBe(false)
    expect(isSearchMode({ enabled: "auto", threshold: 5000 as any }, 5001)).toBe(true)
  })

  test("isSearchMode respects explicit boolean enabled values", () => {
    expect(isSearchMode({ enabled: true }, 100)).toBe(true)
    expect(isSearchMode({ enabled: true }, 0)).toBe(true)
    expect(isSearchMode({ enabled: false }, 100000)).toBe(false)
  })

  test("calculateMcpDefinitionsSize serializes tool definitions and returns total characters", () => {
    const tools = {
      t1: {
        def: { name: "t1", description: "desc1", inputSchema: { type: "object" } },
      },
      t2: {
        def: { name: "t2", description: "desc2", inputSchema: { type: "string" } },
      },
    }
    const size = calculateMcpDefinitionsSize(tools)
    expect(size).toBeGreaterThan(0)
    expect(typeof size).toBe("number")
  })
})

describe("tool-search loaded from history", () => {
  test("returns empty set when no tool_search parts exist", () => {
    const sID = SessionID.make("ses_history_test")
    const messages: SessionV1.WithParts[] = [
      {
        info: { id: MessageID.ascending(), role: "user", sessionID: sID, time: { created: 1 } } as any,
        parts: [{ id: PartID.ascending(), messageID: MessageID.ascending(), sessionID: sID, type: "text", text: "hello" } as any],
      },
    ]
    expect(loadedToolsFromHistory(messages)).toEqual(new Set())
  })

  test("extracts loaded tools from completed tool_search parts across messages", () => {
    const sID = SessionID.make("ses_history_test")
    const messages: SessionV1.WithParts[] = [
      {
        info: { id: MessageID.ascending(), role: "assistant", sessionID: sID, time: { created: 1 } } as any,
        parts: [
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: sID,
            type: "tool",
            tool: "tool_search",
            callID: "call_1",
            state: {
              status: "completed",
              input: { query: "select:tool_a,tool_b" },
              output: "Loaded 2 tools",
              title: "Tool search",
              metadata: { loaded: ["tool_a", "tool_b"] },
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
      {
        info: { id: MessageID.ascending(), role: "assistant", sessionID: sID, time: { created: 2 } } as any,
        parts: [
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: sID,
            type: "tool",
            tool: "tool_search",
            callID: "call_2",
            state: {
              status: "completed",
              input: { query: "select:tool_c" },
              output: "Loaded 1 tool",
              title: "Tool search",
              metadata: { loaded: ["tool_c"] },
              time: { start: 3, end: 4 },
            },
          },
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: sID,
            type: "tool",
            tool: "tool_search",
            callID: "call_3",
            state: {
              status: "running",
              input: { query: "select:tool_d" },
              metadata: { loaded: ["tool_d"] },
              time: { start: 5 },
            },
          },
        ],
      },
    ]

    const loaded = loadedToolsFromHistory(messages)
    expect(loaded.has("tool_a")).toBe(true)
    expect(loaded.has("tool_b")).toBe(true)
    expect(loaded.has("tool_c")).toBe(true)
    // Running / non-completed parts are not yet loaded
    expect(loaded.has("tool_d")).toBe(false)
  })
})

describe("SessionTools.resolve integration with tool_search", () => {
  const sessionID = SessionID.make("ses_tool_search_test")
  const messageID = MessageID.ascending()

  const agent: Agent.Info = {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }

  const model = {
    providerID: ProviderV2.ID.make("test"),
    api: { id: "test-model" },
  } as Provider.Model

  const fakeMcpTools = {
    mcp_tool_database: {
      def: {
        name: "mcp_tool_database",
        description: "Query customer database",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      client: {
        callTool: async () => ({ content: [{ type: "text", text: "query-result" }] }),
      } as any,
      timeout: 30000,
    },
    mcp_tool_mailer: {
      def: {
        name: "mcp_tool_mailer",
        description: "Send emails to customers",
        inputSchema: { type: "object", properties: { to: { type: "string" } } },
      },
      client: {
        callTool: async () => ({ content: [{ type: "text", text: "email-sent" }] }),
      } as any,
      timeout: 30000,
    },
  }

  const mcpService = MCP.Service.of({
    tools: () => Effect.succeed(fakeMcpTools as any),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)

  const fakePlugin = Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: (_name, _input, output) => Effect.succeed(output),
  } satisfies Plugin.Interface)

  const fakePermission = Permission.Service.of({
    ask: () => Effect.void,
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
    getMode: () => Effect.succeed("manual" as const),
    setMode: () => Effect.void,
  } satisfies Permission.Interface)

  const fakeHooks = Hooks.Service.of({
    has: () => false,
    run: () => Effect.succeed({ context: [], warnings: [], ran: 0 }),
  } satisfies Hooks.Interface)

  const fakeTruncate = Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("output.txt"),
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
  } satisfies Truncate.Interface)

  const testConfigLayer = TestConfig.layer({
    get: () => Effect.succeed({ tool_search: { enabled: true } }),
  })

  const layer = Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(Hooks.Service, fakeHooks),
    testConfigLayer,
    Layer.succeed(MCP.Service, mcpService),
    Layer.succeed(Truncate.Service, fakeTruncate),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["invalid"]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        tools: () =>
          Effect.succeed([
            {
              id: "invalid",
              description: "Do not use",
              parameters: Schema.Struct({ tool: Schema.String, error: Schema.String }),
              jsonSchema: { type: "object", properties: { tool: { type: "string" }, error: { type: "string" } } },
              execute: (args: any) =>
                Effect.succeed({
                  title: "Invalid Tool",
                  output: `The arguments provided to the tool are invalid: ${args.error}`,
                  metadata: {},
                }),
            } as any,
          ]),
      }),
    ),
  )

  const it = testEffect(layer)

  it.instance("deferred tool is absent from tool set before tool_search and present after", () =>
    Effect.gen(function* () {
      const processor = {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

      // STEP 1: Before tool_search is called, deferred tools are absent from tools record
      const toolsBefore = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      })

      // Built-in tools and tool_search exist
      expect(toolsBefore["tool_search"]).toBeDefined()
      expect(toolsBefore["tool_search"].description).toContain("mcp_tool_database")
      expect(toolsBefore["tool_search"].description).toContain("mcp_tool_mailer")

      // Deferred MCP tools are ABSENT from the tool set
      expect(toolsBefore["mcp_tool_database"]).toBeUndefined()
      expect(toolsBefore["mcp_tool_mailer"]).toBeUndefined()

      // Calling invalid with a deferred tool informs the model to call tool_search first
      const invalidExecute = toolsBefore["invalid"]?.execute
      expect(invalidExecute).toBeDefined()
      const invalidRes: any = yield* Effect.promise(() =>
        invalidExecute!(
          { tool: "mcp_tool_database", error: "NoSuchTool" },
          { toolCallId: "call_err", abortSignal: new AbortController().signal, messages: [] },
        ),
      )
      expect(invalidRes.output).toContain('Tool "mcp_tool_database" is not loaded yet')
      expect(invalidRes.output).toContain("Call tool_search first")

      // STEP 2: Execute tool_search to load "mcp_tool_database"
      const searchExecute = toolsBefore["tool_search"].execute
      expect(searchExecute).toBeDefined()
      const searchRes: any = yield* Effect.promise(() =>
        searchExecute!(
          { query: "select:mcp_tool_database" },
          { toolCallId: "call_search", abortSignal: new AbortController().signal, messages: [] },
        ),
      )
      expect(searchRes.metadata.loaded).toEqual(["mcp_tool_database"])
      expect(searchRes.output).toContain("mcp_tool_database")
      expect(searchRes.output).toContain("Query customer database")

      // STEP 3: In the next turn/step with tool_search in message history, the tool is now PRESENT
      const historyWithLoadedTool: SessionV1.WithParts[] = [
        {
          info: { id: messageID, role: "assistant", sessionID, time: { created: 1 } } as any,
          parts: [
            {
              id: PartID.ascending(),
              messageID,
              sessionID,
              type: "tool",
              tool: "tool_search",
              callID: "call_search",
              state: {
                status: "completed",
                input: { query: "select:mcp_tool_database" },
                output: searchRes.output,
                title: "Tool search: select:mcp_tool_database",
                metadata: { loaded: ["mcp_tool_database"] },
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
      ]

      const toolsAfter = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        bypassAgentCheck: false,
        messages: historyWithLoadedTool,
        promptOps: {} as never,
      })

      // "mcp_tool_database" is now PRESENT with its full definition and execution
      expect(toolsAfter["mcp_tool_database"]).toBeDefined()
      expect(toolsAfter["mcp_tool_database"].description).toBe("Query customer database")

      // "mcp_tool_mailer" is still deferred
      expect(toolsAfter["mcp_tool_mailer"]).toBeUndefined()
      // tool_search description now only lists the remaining deferred tool
      expect(toolsAfter["tool_search"].description).toContain("mcp_tool_mailer")
      expect(toolsAfter["tool_search"].description).not.toContain("- mcp_tool_database")
    }),
  )

  it.instance("omits denied MCP tools from tool_search and blocks selecting them", () =>
    Effect.gen(function* () {
      const processor = {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.succeed(undefined),
      } as unknown as SessionProcessor.Handle

      const agent: Agent.Info = {
        name: "build",
        mode: "primary",
        permission: [
          { permission: "mcp_tool_mailer", action: "deny", pattern: "*" },
        ],
        options: {},
      }

      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(Effect.provide(layer))

      expect(tools["tool_search"]).toBeDefined()
      // Allowed tool is in description
      expect(tools["tool_search"].description).toContain("mcp_tool_database")
      // Denied tool is NOT in description
      expect(tools["tool_search"].description).not.toContain("mcp_tool_mailer")

      // Attempting to select the denied tool returns no matching tools
      const searchExecute = tools["tool_search"].execute
      const searchRes: any = yield* Effect.promise(() =>
        searchExecute!(
          { query: "select:mcp_tool_mailer" },
          { toolCallId: "call_search_denied", abortSignal: new AbortController().signal, messages: [] },
        ),
      )
      expect(searchRes.metadata.loaded).toEqual([])
      expect(searchRes.output).toContain('No matching tools found for query: "select:mcp_tool_mailer"')
    }),
  )

  it.instance("measures built tool set size reduction with 40 MCP tools (search mode off vs on)", () =>
    Effect.gen(function* () {
      const processor = {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

      const tools40 = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => {
          const num = String(i + 1).padStart(2, "0")
          const name = `service_op_${num}`
          return [
            name,
            {
              def: {
                name,
                description: `Executes business service operation #${num} with parameter validation and enterprise compliance.`,
                inputSchema: {
                  type: "object",
                  properties: {
                    entityId: { type: "string", description: `Target entity for #${num}` },
                    payload: {
                      type: "object",
                      properties: {
                        mode: { type: "string", enum: ["sync", "async", "dry-run"] },
                        retries: { type: "integer" },
                      },
                      required: ["mode"],
                    },
                  },
                  required: ["entityId", "payload"],
                },
              },
              client: { callTool: async () => ({ content: [] }) } as any,
              timeout: 30000,
            },
          ]
        }),
      )

      const mcp40Service = MCP.Service.of({
        tools: () => Effect.succeed(tools40 as any),
        clients: () => Effect.succeed({}),
      } as Partial<MCP.Interface> as MCP.Interface)

      const layerOff = Layer.mergeAll(
        Layer.succeed(Plugin.Service, fakePlugin),
        Layer.succeed(Permission.Service, fakePermission),
        Layer.succeed(Hooks.Service, fakeHooks),
        TestConfig.layer({ get: () => Effect.succeed({ tool_search: { enabled: false } }) }),
        Layer.succeed(MCP.Service, mcp40Service),
        Layer.succeed(Truncate.Service, fakeTruncate),
        RuntimeFlags.layer(),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed([]),
            all: () => Effect.succeed([]),
            named: () => Effect.die("unused"),
            tools: () => Effect.succeed([]),
          }),
        ),
      )

      const layerOn = Layer.mergeAll(
        Layer.succeed(Plugin.Service, fakePlugin),
        Layer.succeed(Permission.Service, fakePermission),
        Layer.succeed(Hooks.Service, fakeHooks),
        TestConfig.layer({ get: () => Effect.succeed({ tool_search: { enabled: "auto", threshold: 10000 as any } }) }),
        Layer.succeed(MCP.Service, mcp40Service),
        Layer.succeed(Truncate.Service, fakeTruncate),
        RuntimeFlags.layer(),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed([]),
            all: () => Effect.succeed([]),
            named: () => Effect.die("unused"),
            tools: () => Effect.succeed([]),
          }),
        ),
      )

      const resolveParams = {
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }

      const toolsOff = yield* SessionTools.resolve(resolveParams).pipe(Effect.provide(layerOff))
      const toolsOn = yield* SessionTools.resolve(resolveParams).pipe(Effect.provide(layerOn))

      const serializeToolSet = (tools: Record<string, any>) => {
        const schemas: Record<string, any> = {}
        for (const [k, v] of Object.entries(tools)) {
          schemas[k] = {
            description: v.description,
            parameters: v.parameters ?? (v.inputSchema as any)?.jsonSchema ?? v.inputSchema,
          }
        }
        return JSON.stringify(schemas)
      }

      const jsonOff = serializeToolSet(toolsOff)
      const jsonOn = serializeToolSet(toolsOn)

      console.log(`\n=== Real check: 40 MCP tools size measurement ===`)
      console.log(`Search mode OFF: ${Object.keys(toolsOff).length} tools, JSON size: ${jsonOff.length} chars (~${(jsonOff.length / 1024).toFixed(1)} KB)`)
      console.log(`Search mode ON:  ${Object.keys(toolsOn).length} tools (tool_search), JSON size: ${jsonOn.length} chars (~${(jsonOn.length / 1024).toFixed(1)} KB)`)
      const pct = (((jsonOff.length - jsonOn.length) / jsonOff.length) * 100).toFixed(1)
      console.log(`Reduction: ${(jsonOff.length - jsonOn.length).toLocaleString()} chars saved (${pct}% reduction)`)

      expect(Object.keys(toolsOff).length).toBe(40)
      expect(Object.keys(toolsOn).length).toBe(1)
      expect(toolsOn["tool_search"]).toBeDefined()
      expect(jsonOn.length).toBeLessThan(jsonOff.length / 2)
    }),
  )
})
