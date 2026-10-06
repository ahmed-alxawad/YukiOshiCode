import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const tools = Array.from({ length: 40 }, (_, index) => {
  const id = String(index).padStart(2, "0")
  return {
    name: `tool_${id}`,
    description: `Fixture operation ${id} for end-to-end MCP tool search coverage`,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }
})

const server = new Server({ name: "e2e-tool-search", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }))
server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
  Promise.resolve({
    content: [{ type: "text", text: `mcp-result:${params.name}:${JSON.stringify(params.arguments ?? {})}` }],
  }),
)

await server.connect(new StdioServerTransport())
