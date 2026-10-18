import { expect, test } from "bun:test"
import { KNOWN_AGENT_KEYS } from "../../src/plugin/claude"

test("agents imported from Claude plugins never keep hooks, mcpServers or memory", () => {
  for (const key of ["hooks", "mcpServers", "memory"]) expect(KNOWN_AGENT_KEYS.has(key)).toBe(false)
})
