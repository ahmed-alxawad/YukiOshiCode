import { describe, expect, test } from "bun:test"
import { redactConfig } from "../../src/cli/cmd/debug/redact"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

describe("debug config output", () => {
  test("masks secrets under keys that do not look secret", () => {
    const out = JSON.stringify(
      redactConfig({
        mcp: {
          local: {
            command: ["server", "--token", github, `--api-key=${openai}`],
            environment: { PATH: "/usr/bin", GREETING: `hello ${openai}` },
          },
        },
        instructions: [`remote: https://user:${github}@example.com/repo`],
        notes: `use ${github}`,
      }),
    )
    expect(out).not.toContain(openai)
    expect(out).not.toContain(github)
    expect(out).toContain("/usr/bin")
    expect(out).toContain("server")
  })

  test("leaves ordinary values alone", () => {
    expect(redactConfig({ name: "example", list: ["a", "--verbose", "b"], n: 3 })).toEqual({
      name: "example",
      list: ["a", "--verbose", "b"],
      n: 3,
    })
  })
})
