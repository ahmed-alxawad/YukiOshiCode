import { expect, test } from "bun:test"
import { Wildcard } from "@/util/wildcard"

test("stacked stars do not backtrack catastrophically on long input", () => {
  const start = performance.now()
  expect(Wildcard.match("a".repeat(5000), "*a*a*a*a*b")).toBe(false)
  expect(Wildcard.match("a".repeat(5000) + "b", "*a*a*a*a*b")).toBe(true)
  expect(performance.now() - start).toBeLessThan(2000)
})

test("special characters, backslashes and trailing ' *' keep their meaning", () => {
  expect(Wildcard.match("a.b", "a.b")).toBe(true)
  expect(Wildcard.match("axb", "a.b")).toBe(false)
  expect(Wildcard.match("C:\\x\\y.ts", "C:/x/*.ts")).toBe(true)
  expect(Wildcard.match("ls", "ls *")).toBe(true)
  expect(Wildcard.match("lsx", "ls *")).toBe(false)
})

test("allStructured matches wildcard head and tail sequences", () => {
  const rules = { "git *": "ask", "git push --force": "deny" }
  expect(Wildcard.allStructured({ head: "git", tail: ["push", "--force"] }, rules)).toBe("deny")
  expect(Wildcard.allStructured({ head: "git", tail: ["log"] }, rules)).toBe("ask")
  expect(Wildcard.allStructured({ head: "rm", tail: [] }, rules)).toBeUndefined()
})
