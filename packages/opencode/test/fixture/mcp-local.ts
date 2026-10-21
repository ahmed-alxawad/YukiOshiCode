import { afterAll, beforeAll, spyOn } from "bun:test"
import { McpGuard } from "../../src/mcp/guard"

/**
 * Lets a test file's MCP servers on localhost be contacted. Remote MCP URLs that resolve to a private or
 * local address are refused unless the global config allows them; these tests are not about that guard.
 */
export function allowLocalMcpServers() {
  let spy: ReturnType<typeof spyOn> | undefined
  beforeAll(() => {
    spy = spyOn(McpGuard, "publicOnlyFetch").mockImplementation((base: typeof fetch = fetch) => base)
  })
  afterAll(() => spy?.mockRestore())
}
