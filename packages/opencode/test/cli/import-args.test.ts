import { expect, test } from "bun:test"
import { importArgsError } from "../../src/cli/cmd/import"

test("--from combined with a file is an error", () => {
  expect(importArgsError("claude", "/nonexistent.jsonl")).toContain("Use --from or a file, not both.")
})

test("--from alone or a file alone is accepted", () => {
  expect(importArgsError("claude", undefined)).toBeUndefined()
  expect(importArgsError(undefined, "x.jsonl")).toBeUndefined()
})
