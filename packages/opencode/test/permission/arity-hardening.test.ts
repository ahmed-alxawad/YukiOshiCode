import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("prototype property names are not treated as arity entries", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    expect(BashArity.prefix([name, "x"])).toEqual([name])
  }
})

test("a prefix is never empty for non-empty input", () => {
  for (const tokens of [["constructor"], ["git"], ["npm", "run"], ["x", "y", "z"], [""], ["a b"]]) {
    expect(BashArity.prefix(tokens).length).toBeGreaterThan(0)
  }
})

test("flags and env-style tokens are not interpreted as subcommands", () => {
  expect(BashArity.prefix(["rm", "-rf", "/"])).toEqual(["rm"])
  expect(BashArity.prefix(["FOO=bar", "git", "push"])).toEqual(["FOO=bar"])
  expect(BashArity.prefix(["sudo", "rm", "-rf", "/"])).toEqual(["sudo"])
  expect(BashArity.prefix(["xargs", "rm"])).toEqual(["xargs"])
})

test("matching is case sensitive and exact per token", () => {
  expect(BashArity.prefix(["GIT", "push", "x"])).toEqual(["GIT"])
  expect(BashArity.prefix(["git ", "push"])).toEqual(["git "])
  expect(BashArity.prefix(["npm", "run"])).toEqual(["npm", "run"])
  expect(BashArity.prefix(["npm"])).toEqual(["npm"])
})

test("unicode and very long inputs are handled", () => {
  expect(BashArity.prefix(["日本語", "コマンド"])).toEqual(["日本語"])
  const long = ["npm", "run", "dev", ...Array.from({ length: 50000 }, (_, i) => `a${i}`)]
  expect(BashArity.prefix(long)).toEqual(["npm", "run", "dev"])
  expect(BashArity.prefix(["x".repeat(1_000_000)])).toHaveLength(1)
})
