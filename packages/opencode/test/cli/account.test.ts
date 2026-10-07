import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { formatAccountLabel, formatOrgLine, isOpencodeUrl } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("identifies opencode.ai URLs as forbidden", () => {
    expect(isOpencodeUrl("https://opencode.ai/console")).toBe(true)
    expect(isOpencodeUrl("https://opencode.ai")).toBe(true)
    expect(isOpencodeUrl("https://api.opencode.ai")).toBe(true)
    expect(isOpencodeUrl("https://opncd.ai")).toBe(true)
    expect(isOpencodeUrl("https://example.com/console")).toBe(false)
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })
})
