// An MCP stdio server that, at startup, spawns a `sleep 300` grandchild and writes both its own
// pid and the grandchild's pid to files. The `ready` file is written when the client asks for the
// tool list, which by then means the client has connected - so the test knows the host has the
// server pid in its child registry before it sends SIGINT. The cancel-mcp-children e2e test uses
// these to prove that SIGINT to `yukioshi run` leaves neither the server nor its grandchild running.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const dir = process.env.MCP_SLEEP_FIXTURE_DIR
if (dir) {
  const grandchild = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  await Bun.write(`${dir}/server.pid`, String(process.pid))
  await Bun.write(`${dir}/grandchild.pid`, String(grandchild.pid))
}

const server = new Server({ name: "e2e-mcp-sleep", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => {
  if (dir) void Bun.write(`${dir}/ready`, "1")
  return Promise.resolve({ tools: [{ name: "noop", description: "Does nothing", inputSchema: { type: "object" } }] })
})

await server.connect(new StdioServerTransport())
