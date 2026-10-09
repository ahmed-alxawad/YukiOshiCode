import { describe, expect, test } from "bun:test"
import { Wildcard } from "../../src/util/wildcard"

describe("Wildcard.match", () => {
  test("literal patterns must match the whole input", () => {
    expect(Wildcard.match("abc", "abc")).toBe(true)
    expect(Wildcard.match("abcd", "abc")).toBe(false)
    expect(Wildcard.match("xabc", "abc")).toBe(false)
    expect(Wildcard.match("", "")).toBe(true)
    expect(Wildcard.match("a", "")).toBe(false)
  })

  test("* matches any run including empty, ? matches exactly one character", () => {
    expect(Wildcard.match("src/a/b.ts", "src/*.ts")).toBe(true)
    expect(Wildcard.match("src/.ts", "src/*.ts")).toBe(true)
    expect(Wildcard.match("f1.txt", "f?.txt")).toBe(true)
    expect(Wildcard.match("f.txt", "f?.txt")).toBe(false)
    expect(Wildcard.match("f12.txt", "f?.txt")).toBe(false)
  })

  test("regex metacharacters in the pattern are literal", () => {
    expect(Wildcard.match("a.b", "a.b")).toBe(true)
    expect(Wildcard.match("axb", "a.b")).toBe(false)
    expect(Wildcard.match("a+b", "a+b")).toBe(true)
    expect(Wildcard.match("aab", "a+b")).toBe(false)
    expect(Wildcard.match("(x)", "(x)")).toBe(true)
    expect(Wildcard.match("[ab]", "[ab]")).toBe(true)
    expect(Wildcard.match("a", "[ab]")).toBe(false)
    expect(Wildcard.match("a|b", "a|b")).toBe(true)
    expect(Wildcard.match("a", "a|b")).toBe(false)
    expect(Wildcard.match("$HOME", "$HOME")).toBe(true)
    expect(Wildcard.match("^x", "^x")).toBe(true)
    expect(Wildcard.match("{1,2}", "{1,2}")).toBe(true)
  })

  test("newlines in the input are matched by * and ?", () => {
    expect(Wildcard.match("a\nb", "a*b")).toBe(true)
    expect(Wildcard.match("a\nb", "a?b")).toBe(true)
  })

  test("backslashes in input and pattern are treated as forward slashes", () => {
    expect(Wildcard.match("C:\\proj\\src\\a.ts", "C:/proj/src/*.ts")).toBe(true)
    expect(Wildcard.match("src/a.ts", "src\\*.ts")).toBe(true)
    expect(Wildcard.match("src\\a.ts", "src\\a.ts")).toBe(true)
  })

  test("a trailing ' *' makes the arguments optional", () => {
    expect(Wildcard.match("git", "git *")).toBe(true)
    expect(Wildcard.match("git status", "git *")).toBe(true)
    expect(Wildcard.match("git  status -s", "git *")).toBe(true)
    expect(Wildcard.match("gitx", "git *")).toBe(false)
    expect(Wildcard.match("gitk status", "git *")).toBe(false)
  })

  test("without a space, a trailing * also matches longer command names", () => {
    expect(Wildcard.match("git", "git*")).toBe(true)
    expect(Wildcard.match("github", "git*")).toBe(true)
  })

  test("a lone * matches everything", () => {
    expect(Wildcard.match("", "*")).toBe(true)
    expect(Wildcard.match("anything at all", "*")).toBe(true)
  })

  test("a pattern with many wildcards does not hang on a non-matching long input", () => {
    const start = performance.now()
    expect(Wildcard.match("a".repeat(5000), "*a*a*a*a*b")).toBe(false)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  test("path traversal is only matched literally, never resolved", () => {
    expect(Wildcard.match("/work/../etc/passwd", "/work/*")).toBe(true)
    expect(Wildcard.match("/etc/passwd", "/work/*")).toBe(false)
    expect(Wildcard.match("/work/../etc/passwd", "/work/../etc/passwd")).toBe(true)
  })
})
