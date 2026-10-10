import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

describe("cli.error", () => {
  test("prints the message of a plain server error instead of its JSON", () => {
    expect(
      FormatError({ name: "UnknownError", data: { message: 'No model selected. Set "model" in yukioshi.json' } }),
    ).toBe('No model selected. Set "model" in yukioshi.json')
  })

  test("formats legacy and tagged config errors the same way", () => {
    const cases = [
      {
        tag: "ConfigJsonError",
        data: { path: "/tmp/opencode.jsonc", message: "Unexpected token" },
        expected:
          "Config file at /tmp/opencode.jsonc is not valid JSON(C): Unexpected token\nFix the syntax in that file (a missing comma, quote or bracket is the usual cause), then run the command again.",
      },
      {
        tag: "ConfigDirectoryTypoError",
        data: { path: "/tmp/opencode.jsonc", dir: ".opencode", suggestion: "opencode" },
        expected:
          'Directory ".opencode" in /tmp/opencode.jsonc is not valid. Rename the directory to "opencode" or remove it. This is a common typo.',
      },
      {
        tag: "ConfigFrontmatterError",
        data: { path: "/tmp/AGENTS.md", message: "failed frontmatter" },
        expected: "failed frontmatter",
      },
      {
        tag: "ConfigInvalidError",
        data: {
          path: "/tmp/opencode.jsonc",
          message: "schema mismatch",
          issues: [{ message: "Expected string", path: ["provider", "id"] }],
        },
        expected:
          "Configuration is invalid at /tmp/opencode.jsonc: schema mismatch\n↳ provider.id: Expected string\nFix the key above in /tmp/opencode.jsonc, then run the command again. `yukioshi debug config` shows the settings YukiOshi reads.",
      },
    ]

    for (const item of cases) {
      expect(FormatError({ name: item.tag, data: item.data })).toBe(item.expected)
      expect(FormatError({ _tag: item.tag, ...item.data })).toBe(item.expected)
    }
  })

  test("preserves multiline JSONC diagnostics for tagged config errors", () => {
    const data = {
      path: "/tmp/opencode.jsonc",
      message:
        '\n--- JSONC Input ---\n{\n  "model": \n}\n--- Errors ---\nValueExpected at line 3, column 1\n   Line 3: }\n          ^\n--- End ---',
    }
    const expected = [
      `Config file at ${data.path} is not valid JSON(C): ValueExpected at line 3, column 1`,
      "   Line 3: }",
      "          ^",
      "Fix the syntax in that file (a missing comma, quote or bracket is the usual cause), then run the command again.",
    ].join("\n")

    // The echoed file contents are dropped: they can hold keys, and the diagnostics already point at the line.
    expect(FormatError({ name: "ConfigJsonError", data })).toBe(expected)
    expect(FormatError({ _tag: "ConfigJsonError", ...data })).toBe(expected)
  })

  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://console.opencode.ai/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://console.opencode.ai/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats legacy and tagged provider model errors the same way", () => {
    const data = {
      providerID: "anthropic",
      modelID: "claude-sonet-4",
      suggestions: ["claude-sonnet-4"],
    }
    const expected = [
      "Model not found: anthropic/claude-sonet-4",
      "Did you mean: claude-sonnet-4",
      "Try: `yukioshi models` to list available models",
      "Or check your config (yukioshi.json or legacy opencode.json) provider/model names",
    ].join("\n")

    expect(FormatError({ name: "ProviderModelNotFoundError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderModelNotFoundError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider init errors the same way", () => {
    const data = { providerID: "anthropic" }
    const expected = 'Failed to initialize provider "anthropic". Check credentials and configuration.'

    expect(FormatError({ name: "ProviderInitError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderInitError", ...data })).toBe(expected)
  })

  test("formats cancelled UI errors as empty output", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
  })
})
