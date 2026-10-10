import { describe, expect, test } from "bun:test"
import { schemaViolation } from "../../../src/cli/cmd/run/schema"

const schema = {
  type: "object",
  properties: { risk: { enum: ["low", "high"] }, files: { type: "array", items: { type: "string" } } },
  required: ["risk", "files"],
}

describe("--output-schema answer check", () => {
  test("an answer that matches the schema passes", () => {
    expect(schemaViolation(schema, { risk: "low", files: ["a.ts"] })).toBeUndefined()
    expect(schemaViolation(schema, { risk: "high", files: [] })).toBeUndefined()
  })

  test("a missing required property fails", () => {
    expect(schemaViolation(schema, { risk: "low" })).toContain('missing "files"')
  })

  test("a value outside an enum fails", () => {
    expect(schemaViolation(schema, { risk: "nope", files: [] })).toContain("must be one of")
  })

  test("a wrong type fails, also inside arrays", () => {
    expect(schemaViolation(schema, "text")).toContain("must be object")
    expect(schemaViolation(schema, { risk: "low", files: [1] })).toContain("$.files[0] must be string")
  })

  test("integers, bounds, additionalProperties and local $ref are checked", () => {
    expect(schemaViolation({ type: "integer" }, 1.5)).toContain("must be integer")
    expect(schemaViolation({ type: "integer" }, 2)).toBeUndefined()
    expect(schemaViolation({ type: "number", minimum: 1 }, 0)).toContain("at least")
    expect(schemaViolation({ type: "object", additionalProperties: false }, { x: 1 })).toContain("unexpected")
    const refs = { type: "object", properties: { a: { $ref: "#/$defs/s" } }, $defs: { s: { type: "string" } } }
    expect(schemaViolation(refs, { a: "ok" })).toBeUndefined()
    expect(schemaViolation(refs, { a: 1 })).toContain("$.a must be string")
  })

  test("anyOf and oneOf need a matching shape", () => {
    expect(schemaViolation({ anyOf: [{ type: "string" }, { type: "null" }] }, null)).toBeUndefined()
    expect(schemaViolation({ anyOf: [{ type: "string" }, { type: "null" }] }, 3)).toContain("any allowed")
    expect(schemaViolation({ oneOf: [{ type: "number" }, { minimum: 0 }] }, 5)).toContain("exactly one")
  })
})
