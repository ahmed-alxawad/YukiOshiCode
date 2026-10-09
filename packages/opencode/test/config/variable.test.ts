import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigVariable } from "../../src/config/variable"
import { tmpdir } from "../fixture/fixture"

const virtual = (text: string, dir: string, extra: Partial<Parameters<typeof ConfigVariable.substitute>[0]> = {}) =>
  ConfigVariable.substitute({ type: "virtual", source: "virtual.json", dir, text, ...extra } as any)

describe("ConfigVariable.substitute: env", () => {
  test("replaces {env:NAME} from the explicit env first, then process.env", async () => {
    process.env.YK_VAR_TEST_A = "from-process"
    try {
      expect(await virtual("{env:YK_VAR_TEST_A}", ".")).toBe("from-process")
      expect(await virtual("{env:YK_VAR_TEST_A}", ".", { env: { YK_VAR_TEST_A: "explicit" } })).toBe("explicit")
    } finally {
      delete process.env.YK_VAR_TEST_A
    }
  })

  test("unset and empty variables become the empty string, even with missing: error", async () => {
    process.env.YK_VAR_TEST_EMPTY = ""
    try {
      expect(await virtual('{"k":"{env:YK_VAR_TEST_NOPE}"}', ".")).toBe('{"k":""}')
      expect(await virtual('{"k":"{env:YK_VAR_TEST_EMPTY}"}', ".")).toBe('{"k":""}')
    } finally {
      delete process.env.YK_VAR_TEST_EMPTY
    }
  })

  test("an explicit empty value overrides process.env", async () => {
    process.env.YK_VAR_TEST_B = "proc"
    try {
      expect(await virtual("{env:YK_VAR_TEST_B}", ".", { env: { YK_VAR_TEST_B: "" } })).toBe("")
    } finally {
      delete process.env.YK_VAR_TEST_B
    }
  })

  test("replaces every occurrence and leaves unrelated braces alone", async () => {
    expect(await virtual("{env:A}-{env:A} {x} {env} {env:}", ".", { env: { A: "1" } })).toBe("1-1 {x} {env} {env:}")
  })

  test("env values are inserted verbatim (no recursive expansion)", async () => {
    expect(await virtual("{env:A}", ".", { env: { A: "{env:B}" } })).toBe("{env:B}")
  })

  test("text with no substitutions is returned unchanged", async () => {
    expect(await virtual("", ".")).toBe("")
    expect(await virtual('{"a":1}', ".")).toBe('{"a":1}')
  })
})

describe("ConfigVariable.substitute: file", () => {
  test("reads relative paths from the config directory and trims the content", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "key.txt"), "  secret\n\n")
    expect(await virtual('{"k":"{file:key.txt}"}', tmp.path)).toBe('{"k":"secret"}')
    expect(await virtual('{"k":"{file:./key.txt}"}', tmp.path)).toBe('{"k":"secret"}')
  })

  test("resolves relative to the real config file's directory for path sources", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "sub"))
    await fs.writeFile(path.join(tmp.path, "sub", "v.txt"), "value")
    const out = await ConfigVariable.substitute({
      type: "path",
      path: path.join(tmp.path, "sub", "config.json"),
      text: "{file:v.txt}",
    })
    expect(out).toBe("value")
  })

  test("supports parent directory traversal, absolute paths and ~/", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "a"))
    await fs.writeFile(path.join(tmp.path, "top.txt"), "top")
    expect(await virtual("{file:../top.txt}", path.join(tmp.path, "a"))).toBe("top")
    expect(await virtual(`{file:${path.join(tmp.path, "top.txt")}}`, ".")).toBe("top")

    const name = `.yk-var-test-${process.pid}-${Date.now()}`
    const home = path.join(os.homedir(), name)
    await fs.writeFile(home, "homeval")
    try {
      expect(await virtual(`{file:~/${name}}`, tmp.path)).toBe("homeval")
    } finally {
      await fs.rm(home, { force: true })
    }
  })

  test("escapes quotes, backslashes and newlines so the result stays valid JSON", async () => {
    await using tmp = await tmpdir()
    const value = 'say "hi"\nline2\\end\ttab'
    await fs.writeFile(path.join(tmp.path, "v.txt"), value)
    const out = await virtual('{"k":"{file:v.txt}"}', tmp.path)
    expect(JSON.parse(out)).toEqual({ k: value })
  })

  test("handles unicode content and windows line endings", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "v.txt"), "日本語 🎉\r\nsecond\r\n")
    expect(JSON.parse(await virtual('"{file:v.txt}"', tmp.path))).toBe("日本語 🎉\r\nsecond")
  })

  test("an empty file becomes an empty string", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "e.txt"), "")
    expect(await virtual('"{file:e.txt}"', tmp.path)).toBe('""')
  })

  test("file references on // comment lines are left unresolved and do not read the file", async () => {
    await using tmp = await tmpdir()
    const text = '{\n  // "k": "{file:missing.txt}"\n  "a": 1\n}'
    expect(await virtual(text, tmp.path)).toBe(text)
  })

  test("a reference after code on the same line is still resolved", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "v.txt"), "x")
    expect(await virtual('"a": "{file:v.txt}" // c', tmp.path)).toBe('"a": "x" // c')
  })

  test("handles several references, mixed with comment lines", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "a.txt"), "A")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "B")
    const text = '"{file:a.txt}"\n  // {file:nope.txt}\n"{file:b.txt}"'
    expect(await virtual(text, tmp.path)).toBe('"A"\n  // {file:nope.txt}\n"B"')
  })

  test("file content is not re-scanned for further substitutions", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "a.txt"), "{file:b.txt}")
    await fs.writeFile(path.join(tmp.path, "b.txt"), "B")
    expect(await virtual('"{file:a.txt}"', tmp.path)).toBe('"{file:b.txt}"')
  })

  test("a missing file raises a config error naming the token, path and source", async () => {
    await using tmp = await tmpdir()
    const err = await virtual("{file:nope.txt}", tmp.path).catch((e) => e)
    expect(err?.name).toBe("ConfigInvalidError")
    expect(err.data.path).toBe("virtual.json")
    expect(err.data.message).toContain('bad file reference: "{file:nope.txt}"')
    expect(err.data.message).toContain(path.join(tmp.path, "nope.txt"))
    expect(err.data.message).toContain("does not exist")
  })

  test("a directory instead of a file raises a config error without a does-not-exist hint", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "dir"))
    const err = await virtual("{file:dir}", tmp.path).catch((e) => e)
    expect(err?.name).toBe("ConfigInvalidError")
    expect(err.data.message).toContain('bad file reference: "{file:dir}"')
    expect(err.data.message).not.toContain("does not exist")
  })

  test("missing: empty turns unreadable files into empty strings", async () => {
    await using tmp = await tmpdir()
    expect(await virtual('"{file:nope.txt}"', tmp.path, { missing: "empty" })).toBe('""')
  })
})
