import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigParse } from "../../src/config/parse"

describe("ConfigParse.jsonc", () => {
  test("parses plain JSON, comments and trailing commas", () => {
    expect(ConfigParse.jsonc('{"a":1}', "c.json")).toEqual({ a: 1 })
    expect(ConfigParse.jsonc('{\n // c\n "a": [1, 2,], /* x */\n}', "c.jsonc")).toEqual({ a: [1, 2] })
  })

  test("empty and whitespace-only documents are rejected", () => {
    expect(() => ConfigParse.jsonc("", "c.json")).toThrow()
    expect(() => ConfigParse.jsonc("   \n", "c.json")).toThrow()
  })

  test("keeps comment markers that are inside strings", () => {
    expect(ConfigParse.jsonc('{"url":"https://example.com//x","c":"/* no */"}', "c.json")).toEqual({
      url: "https://example.com//x",
      c: "/* no */",
    })
  })

  test("throws a JsonError with the path, line, column and the offending line", () => {
    const text = '{\n  "a": 1,\n  "b": ,\n}'
    let error: any
    try {
      ConfigParse.jsonc(text, "/cfg/yukioshi.json")
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    expect(error.name).toBe("ConfigJsonError")
    expect(error.data.path).toBe("/cfg/yukioshi.json")
    expect(error.data.message).toContain("--- JSONC Input ---")
    expect(error.data.message).toContain("at line 3")
    expect(error.data.message).toContain('Line 3:   "b": ,')
  })

  test("reports every error and stays safe on garbage input", () => {
    for (const text of ["{", "}", "[1,", "{'a':1}", "\u0000", "{\"a\": 1 \"b\": 2}", "{\"a\": tru}"]) {
      expect(() => ConfigParse.jsonc(text, "x")).toThrow()
    }
  })

  test("an error on a line past the end of text does not crash the formatter", () => {
    expect(() => ConfigParse.jsonc('{"a":', "x")).toThrow()
  })
})

describe("ConfigParse.schema", () => {
  const Info = Schema.Struct({ name: Schema.String, count: Schema.optional(Schema.Number) })

  test("returns decoded data", () => {
    expect(ConfigParse.schema(Info, { name: "x", count: 2 }, "src")).toEqual({ name: "x", count: 2 })
  })

  test("ignores unknown properties", () => {
    expect(ConfigParse.schema(Info, { name: "x", extra: true }, "src")).toEqual({ name: "x" })
  })

  test("throws an InvalidError carrying the source and every issue with its path", () => {
    let error: any
    try {
      ConfigParse.schema(Info, { name: 1, count: "two" }, "/cfg/a.json")
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    expect(error.name).toBe("ConfigInvalidError")
    expect(error.data.path).toBe("/cfg/a.json")
    const paths = error.data.issues.map((i: any) => i.path.join("."))
    expect(paths).toContain("name")
    expect(paths).toContain("count")
    for (const issue of error.data.issues) expect(typeof issue.message).toBe("string")
  })

  test("non-object input is rejected rather than coerced", () => {
    for (const bad of [null, undefined, 5, "str", []]) {
      expect(() => ConfigParse.schema(Info, bad, "src")).toThrow()
    }
  })
})
