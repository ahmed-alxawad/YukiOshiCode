import { describe, expect, test } from "bun:test"
import { LANGUAGE_EXTENSIONS } from "../../src/util/language"

describe("util.language", () => {
  test("maps common extensions to expected language identifiers", () => {
    expect(LANGUAGE_EXTENSIONS[".ts"]).toBe("typescript")
    expect(LANGUAGE_EXTENSIONS[".tsx"]).toBe("typescriptreact")
    expect(LANGUAGE_EXTENSIONS[".py"]).toBe("python")
    expect(LANGUAGE_EXTENSIONS[".go"]).toBe("go")
    expect(LANGUAGE_EXTENSIONS[".rs"]).toBe("rust")
  })
})
