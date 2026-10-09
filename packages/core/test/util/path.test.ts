import { describe, expect, test } from "bun:test"
import {
  getDirectory,
  getFileExtension,
  getFilename,
  getFilenameTruncated,
  truncateMiddle,
} from "../../src/util/path"

describe("getFilename", () => {
  test("handles posix, windows and mixed separators", () => {
    expect(getFilename("/a/b/c.txt")).toBe("c.txt")
    expect(getFilename("C:\\Users\\me\\c.txt")).toBe("c.txt")
    expect(getFilename("a/b\\c.txt")).toBe("c.txt")
  })

  test("ignores trailing separators", () => {
    expect(getFilename("/a/b/")).toBe("b")
    expect(getFilename("C:\\a\\b\\\\")).toBe("b")
    expect(getFilename("a///")).toBe("a")
  })

  test("returns empty string for missing, empty and root paths", () => {
    expect(getFilename(undefined)).toBe("")
    expect(getFilename("")).toBe("")
    expect(getFilename("/")).toBe("")
    expect(getFilename("\\\\")).toBe("")
  })

  test("bare names, dot segments and unicode are returned as-is", () => {
    expect(getFilename("file")).toBe("file")
    expect(getFilename("/a/..")).toBe("..")
    expect(getFilename("../x/.hidden")).toBe(".hidden")
    expect(getFilename("/データ/ファイル 🎉.md")).toBe("ファイル 🎉.md")
  })
})

describe("getDirectory", () => {
  test("returns the parent with a trailing slash, normalising windows separators", () => {
    expect(getDirectory("/a/b/c.txt")).toBe("/a/b/")
    expect(getDirectory("C:\\a\\b\\c.txt")).toBe("C:/a/b/")
    expect(getDirectory("/a/b/")).toBe("/a/")
  })

  test("returns empty string for missing input", () => {
    expect(getDirectory(undefined)).toBe("")
    expect(getDirectory("")).toBe("")
  })

  test("a bare filename has an empty parent that still ends with a slash", () => {
    expect(getDirectory("file.txt")).toBe("/")
  })
})

describe("getFileExtension", () => {
  test("returns the text after the last dot", () => {
    expect(getFileExtension("a/b/c.tar.gz")).toBe("gz")
    expect(getFileExtension("c.TXT")).toBe("TXT")
  })

  test("returns empty for missing input and the whole name when there is no dot", () => {
    expect(getFileExtension(undefined)).toBe("")
    expect(getFileExtension("")).toBe("")
    expect(getFileExtension("Makefile")).toBe("Makefile")
  })
})

describe("getFilenameTruncated", () => {
  test("keeps short names", () => {
    expect(getFilenameTruncated("/x/short.ts")).toBe("short.ts")
    expect(getFilenameTruncated("/x/" + "a".repeat(20))).toBe("a".repeat(20))
  })

  test("truncates the stem and keeps the extension", () => {
    const out = getFilenameTruncated("/x/" + "a".repeat(40) + ".tsx", 20)
    expect(out.length).toBe(20)
    expect(out.endsWith("….tsx")).toBe(true)
  })

  test("truncates names without an extension or with a leading dot only", () => {
    expect(getFilenameTruncated("b".repeat(30), 10)).toBe("b".repeat(9) + "…")
    expect(getFilenameTruncated("." + "h".repeat(30), 10)).toBe("." + "h".repeat(8) + "…")
  })

  test("falls back to a plain cut when the extension leaves no room", () => {
    const out = getFilenameTruncated("name." + "e".repeat(30), 10)
    expect(out.length).toBe(10)
    expect(out.endsWith("…")).toBe(true)
  })

  test("empty path gives empty output", () => {
    expect(getFilenameTruncated(undefined)).toBe("")
  })
})

describe("truncateMiddle", () => {
  test("returns short text unchanged", () => {
    expect(truncateMiddle("abc", 3)).toBe("abc")
    expect(truncateMiddle("", 5)).toBe("")
  })

  test("keeps both ends and the requested total length", () => {
    const out = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 11)
    expect(out).toBe("abcde…vwxyz")
    expect(out.length).toBe(11)
  })

  test("odd and even budgets favour the start", () => {
    expect(truncateMiddle("abcdefghij", 6)).toBe("abc…ij")
  })

  test("a budget of one leaves only the ellipsis and the tail slice does not leak the whole text", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…")
    expect(truncateMiddle("abcdef", 2)).toBe("a…")
  })

  test("a non-positive budget returns an empty string", () => {
    expect(truncateMiddle("abcdef", 0)).toBe("")
    expect(truncateMiddle("abcdef", -4)).toBe("")
  })
})
