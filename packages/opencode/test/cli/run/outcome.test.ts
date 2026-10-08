import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EXIT, dollars, goalExitCode, readOutputSchema } from "../../../src/cli/cmd/run/outcome"

describe("run outcome", () => {
  const since = 1_000

  test("a goal that paused during the run sets its exit code", () => {
    expect(goalExitCode({ status: "paused", paused: "blocked", updated: 2_000 }, since)).toBe(EXIT.goalBlocked)
    expect(goalExitCode({ status: "paused", paused: "refused", updated: 2_000 }, since)).toBe(EXIT.goalBlocked)
    expect(goalExitCode({ status: "paused", paused: "rounds", updated: 2_000 }, since)).toBe(EXIT.goalRounds)
  })

  test("a finished goal, an older pause, or a pause for an error leaves the exit code alone", () => {
    expect(goalExitCode(undefined, since)).toBeUndefined()
    expect(goalExitCode({ status: "done", updated: 2_000 }, since)).toBeUndefined()
    expect(goalExitCode({ status: "active", updated: 2_000 }, since)).toBeUndefined()
    expect(goalExitCode({ status: "paused", paused: "rounds", updated: 500 }, since)).toBeUndefined()
    expect(goalExitCode({ status: "paused", paused: "error", updated: 2_000 }, since)).toBeUndefined()
    expect(goalExitCode({ status: "paused", paused: "interrupted", updated: 2_000 }, since)).toBeUndefined()
  })

  test("--output-schema accepts inline JSON or a file", async () => {
    expect(await readOutputSchema('{"type":"object"}')).toEqual({ type: "object" })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yk-schema-"))
    fs.writeFileSync(path.join(dir, "answer.json"), '{"type":"object","required":["answer"]}')
    expect(await readOutputSchema("answer.json", dir)).toEqual({ type: "object", required: ["answer"] })
  })

  test("--output-schema rejects a missing file, invalid JSON, and non-objects", async () => {
    await expect(readOutputSchema("missing.json", os.tmpdir())).rejects.toThrow("Cannot read the --output-schema file")
    await expect(readOutputSchema("{not json")).rejects.toThrow("is not valid JSON")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yk-schema-"))
    fs.writeFileSync(path.join(dir, "list.json"), "[1, 2]")
    await expect(readOutputSchema("list.json", dir)).rejects.toThrow("must be a JSON Schema object")
  })

  test("--output-schema rejects remote $ref URLs and external references", async () => {
    await expect(readOutputSchema('{"type":"object","$ref":"https://evil.example.com/schema.json"}')).rejects.toThrow(
      "must not contain remote or external $ref references",
    )
    await expect(readOutputSchema('{"type":"object","$ref":"http://169.254.169.254/latest/meta-data/"}')).rejects.toThrow(
      "must not contain remote or external $ref references",
    )
    await expect(readOutputSchema('{"type":"object","$ref":"file:///etc/passwd"}')).rejects.toThrow(
      "must not contain remote or external $ref references",
    )
    await expect(
      readOutputSchema('{"type":"object","properties":{"user":{"$ref":"https://evil.com/user"}}}'),
    ).rejects.toThrow("must not contain remote or external $ref references")
    // Local in-schema references are allowed
    expect(
      await readOutputSchema('{"type":"object","properties":{"user":{"$ref":"#/$defs/user"}},"$defs":{"user":{"type":"string"}}}'),
    ).toMatchObject({ type: "object" })
  })

  test("--output-schema rejects oversized and deeply nested schemas", async () => {
    const huge = JSON.stringify({ type: "object", description: "a".repeat(70_000) })
    await expect(readOutputSchema(huge)).rejects.toThrow("too large")

    let deep: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 35; i++) {
      deep = { type: "object", properties: { nested: deep } }
    }
    await expect(readOutputSchema(JSON.stringify(deep))).rejects.toThrow("exceeds maximum nesting depth")
  })

  test("dollars shows small amounts with more precision", () => {
    expect(dollars(2.5)).toBe("$2.50")
    expect(dollars(0.0123)).toBe("$0.0123")
  })
})
