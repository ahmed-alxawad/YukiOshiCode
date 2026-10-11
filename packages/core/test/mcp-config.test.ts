import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMCPV1 } from "../src/v1/config/mcp"

const decodeLocal = Schema.decodeUnknownSync(ConfigMCPV1.Local)

test("local MCP config accepts both explicit environment aliases", () => {
  expect(
    decodeLocal({
      type: "local",
      command: ["example-mcp"],
      environment: { SHARED_TOKEN: "canonical", CANONICAL_TOKEN: "canonical" },
      env: { ALIAS_TOKEN: "alias", SHARED_TOKEN: "alias" },
      inherit_env: true,
    }),
  ).toEqual({
    type: "local",
    command: ["example-mcp"],
    environment: { ALIAS_TOKEN: "alias", SHARED_TOKEN: "canonical", CANONICAL_TOKEN: "canonical" },
    inherit_env: true,
  })
})
