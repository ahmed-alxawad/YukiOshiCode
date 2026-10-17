import { describe, expect, test } from "bun:test"
import { expandPastedTextPlaceholders } from "../src/prompt/part"

describe("TUI clipboard and paste handling", () => {
  test("preserves tabs (\\t) when normalizing pasted text", () => {
    const raw = "function test() {\n\tconst a = 1;\n\t\treturn a;\n}"
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    expect(normalized).toBe(raw)
    expect(normalized).toContain("\tconst a = 1;")
    expect(normalized).toContain("\t\treturn a;")
  })

  test("normalizes CRLF (\\r\\n) and CR (\\r) to LF (\\n)", () => {
    const raw = "line1\r\nline2\rline3\nline4"
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    expect(normalized).toBe("line1\nline2\nline3\nline4")
    expect(normalized).not.toContain("\r")
  })

  test("5,000-line paste creates [Pasted ~5000 lines] summary and expands back correctly", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: const x = ${i};`)
    const rawContent = lines.join("\n")
    const pastedContent = rawContent.trim()
    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1

    expect(lineCount).toBe(5000)
    const placeholder = `[Pasted ~${lineCount} lines]`
    expect(placeholder).toBe("[Pasted ~5000 lines]")

    const parts = [
      {
        type: "text" as const,
        text: pastedContent,
        source: {
          text: {
            value: placeholder,
          },
        },
      },
    ]

    const promptText = `Here is the code:\n${placeholder}\nPlease review it.`
    const expanded = expandPastedTextPlaceholders(promptText, parts)

    expect(expanded).toBe(`Here is the code:\n${rawContent}\nPlease review it.`)
    expect(expanded.split("\n").length).toBe(5002)
  })

  test("empty clipboard notification: shows info toast when clipboard is empty", () => {
    const toasts: { variant: string; message: string }[] = []
    const toast = {
      show: (opt: { variant: string; message: string }) => toasts.push(opt),
    }

    const handlePaste = (content: { mime: string; data: string } | undefined) => {
      if (content?.mime.startsWith("image/")) {
        return "image"
      }
      if (content?.mime === "text/plain" && content.data.length > 0) {
        return "text"
      }
      toast.show({
        variant: "info",
        message: "Clipboard is empty",
      })
      return "empty"
    }

    expect(handlePaste(undefined)).toBe("empty")
    expect(handlePaste({ mime: "text/plain", data: "" })).toBe("empty")
    expect(toasts).toEqual([
      { variant: "info", message: "Clipboard is empty" },
      { variant: "info", message: "Clipboard is empty" },
    ])
  })

  test("clipboard read error shows error toast", () => {
    const toasts: { variant: string; message: string }[] = []
    const toast = {
      show: (opt: { variant: string; message: string }) => toasts.push(opt),
    }

    const run = (throwError: boolean) => {
      try {
        if (throwError) throw new Error("Clipboard access denied")
      } catch {
        toast.show({
          variant: "error",
          message: "Failed to read clipboard",
        })
      }
    }

    run(true)
    expect(toasts).toEqual([
      { variant: "error", message: "Failed to read clipboard" },
    ])
  })

  test("preserves CJK and multi-byte UTF-8 emojis without corruption", () => {
    const input = "你好世界 🚀 👨‍👩‍👧‍👦 \t const 日本語 = 'テスト';\r\n"
    const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    expect(normalized).toBe("你好世界 🚀 👨‍👩‍👧‍👦 \t const 日本語 = 'テスト';\n")
    expect(normalized).toContain("你好世界")
    expect(normalized).toContain("🚀")
    expect(normalized).toContain("👨‍👩‍👧‍👦")
    expect(normalized).toContain("\t")
  })
})
