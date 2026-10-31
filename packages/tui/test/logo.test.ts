import { describe, expect, test } from "bun:test"
import { resolve } from "@yukioshi/core/edition"
import { renderWordmark } from "../src/logo"

describe("wordmark per edition", () => {
  test("the Kothora edition prints a plain text wordmark, no YukiOshi art", () => {
    const lines = renderWordmark({ edition: resolve("kothora", undefined) })
    expect(lines).toEqual(["Kothora Code"])
    expect(renderWordmark({ edition: resolve("kothora", undefined), pad: "  " })).toEqual(["  Kothora Code"])
    const colored = renderWordmark({ edition: resolve("kothora", undefined), color: true })
    expect(colored).toEqual(["\x1b[1mKothora Code\x1b[0m"])
  })

  test("the yukioshi edition keeps the traced wordmark and the CODE line", () => {
    const lines = renderWordmark({ edition: resolve("yukioshi", undefined) })
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.at(-1)).toContain("C O D E")
    expect(lines.join("\n")).not.toContain("Kothora")
    // Default (no edition passed, none defined in tests) is the same as yukioshi.
    expect(renderWordmark()).toEqual(lines)
  })
})
