import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

describe("McpCatalog.convertTool total timeout", () => {
  test("a tool that reports progress forever is cut off", async () => {
    const timers: ReturnType<typeof setInterval>[] = []
    const server = new Server({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [mcpTool()] }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const token = request.params._meta?.progressToken
      const timer = setInterval(() => {
        if (token === undefined) return
        void server.notification({ method: "notifications/progress", params: { progressToken: token, progress: Date.now() } })
      }, 20)
      timers.push(timer)
      await new Promise((resolve) => extra.signal.addEventListener("abort", resolve))
      clearInterval(timer)
      return { content: [] }
    })
    const client = new Client({ name: "test", version: "1.0.0" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    // Tiny caps (200 ms idle timeout, 400 ms total) keep the real 30 minute default out of the test.
    const converted = McpCatalog.convertTool(mcpTool(), client, 200, 400)
    const started = Date.now()
    // Without the cap the call never settles, so bound the wait and always clean up the progress timer.
    let guard: ReturnType<typeof setTimeout> | undefined
    const stuck = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("tool call was never cut off")), 3000)
    })
    try {
      await expect(Promise.race([converted.execute?.({}, options), stuck])).rejects.toThrow(/timeout|timed out/i)
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      clearTimeout(guard)
      timers.forEach(clearInterval)
      await Promise.all([client.close(), server.close()])
    }
  }, 5000)
})
