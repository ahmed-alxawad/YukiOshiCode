import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"

describe("piped output", () => {
  test("debug skill emits complete JSON over a pipe", () => {
    const output = execFileSync("bun", ["run", "src/index.ts", "debug", "skill"], { encoding: "utf8" })
    expect(output.length).toBeGreaterThan(64_000)
    expect(JSON.parse(output)).toBeArray()
  })
})
