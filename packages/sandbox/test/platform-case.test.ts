import { describe, expect, test } from "bun:test"
import { select } from "../src/backend"
import { foldsCase, hasDeniedName, matches } from "../src/path"

describe("case-insensitive filesystem handling", () => {
  test("folds case on win32 and darwin only", () => {
    expect(foldsCase("darwin")).toBe(true)
    expect(foldsCase("win32")).toBe(true)
    expect(foldsCase("linux")).toBe(false)
  })

  test("denyNames match .GIT on darwin and win32 but not linux", () => {
    const target = "/repo/.GIT/hooks/pre-commit"
    expect(hasDeniedName(target, [".git"], "darwin")).toBe(true)
    expect(hasDeniedName(target, [".git"], "win32")).toBe(true)
    expect(hasDeniedName(target, [".git"], "linux")).toBe(false)
    expect(hasDeniedName("/repo/src/a.ts", [".git"], "darwin")).toBe(false)
  })

  test("denyWrite rules match differently-cased targets on darwin and win32", () => {
    const rule = { path: "/repo/secret", kind: "subtree" as const }
    expect(matches(rule, "/repo/SECRET/x", "darwin")).toBe(true)
    expect(matches(rule, "/repo/SECRET/x", "win32")).toBe(true)
    expect(matches(rule, "/repo/SECRET/x", "linux")).toBe(false)
    expect(matches({ path: "/repo/a", kind: "literal" }, "/repo/A", "darwin")).toBe(true)
  })

  test("win32 backend reports unavailable so prepare fails closed", () => {
    const support = select("win32").support()
    expect(support.available).toBe(false)
    expect(support.reason).toContain("Windows")
  })
})
