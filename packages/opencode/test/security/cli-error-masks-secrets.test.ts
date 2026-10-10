import { describe, expect, test } from "bun:test"
import { FormatError } from "../../src/cli/error"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"

describe("top-level CLI error text", () => {
  test("masks a credential quoted in a config error", () => {
    const text = FormatError({ name: "ConfigJsonError", data: { path: "/x.json", message: `bad value ${openai}` } })
    expect(text).toContain("/x.json")
    expect(text).not.toContain(openai)
  })
})
