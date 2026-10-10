import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { MemoryStore } from "../../src/memory/store"
import { MemoryPaths } from "../../src/memory/paths"

async function tmproot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "memory-store-guards-"))
}

describe("MemoryStore.tidy", () => {
  test("collapses every kind of line break so one entry cannot pose as several", () => {
    expect(MemoryStore.tidy("a\nb")).toBe("a b")
    expect(MemoryStore.tidy("a\r\nb")).toBe("a b")
    expect(MemoryStore.tidy("a b c")).toBe("a b c")
    expect(MemoryStore.tidy("a  \n\n  ## Heading\n- x :: y")).toBe("a ## Heading - x :: y")
    expect(MemoryStore.tidy("  \n ")).toBe("")
  })
})

describe("MemoryStore.remember input handling", () => {
  test("a multi-line value is stored as a single entry and cannot inject a heading or entry", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "fact one\n## Corrections\n- evil :: injected" })
    const catalog = await MemoryStore.catalog({ root })
    expect(catalog.count).toBe(1)
    expect(Object.keys(catalog.bySource)).toEqual(["project.md"])
    const raw = await fs.readFile(MemoryPaths.source(root, "project.md"), "utf8")
    expect(raw.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Facts"])
  })

  test("blank text saves nothing and creates no entry", async () => {
    const root = await tmproot()
    expect(await MemoryStore.remember({ root, file: "project.md", text: " \n\t " })).toEqual({ key: "", changed: false })
    expect((await MemoryStore.catalog({ root })).count).toBe(0)
  })

  test("a key containing the separator cannot split the entry", async () => {
    const root = await tmproot()
    const saved = await MemoryStore.remember({ root, file: "project.md", key: "a :: b", text: "value" })
    expect(saved.key).toBe("a : b")
    const hits = await MemoryStore.search({ root, query: "value", limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0].key).toBe("a : b")
    expect(hits[0].text).toBe("value")
  })

  test("saving identical text twice reports no change", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "k", text: "same" })
    expect((await MemoryStore.remember({ root, file: "project.md", key: "k", text: "same" })).changed).toBe(false)
  })

  test("unicode text round-trips", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "名前", text: "日本語のメモ 🚀" })
    const hits = await MemoryStore.search({ root, query: "日本語のメモ", limit: 5 })
    expect(hits.map((h) => h.key)).toEqual(["名前"])
  })
})

describe("MemoryStore size limit", () => {
  test("rejects a save that would exceed the limit and leaves the file untouched", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "a", text: "x".repeat(50) })
    const file = MemoryPaths.source(root, "project.md")
    const before = await fs.readFile(file, "utf8")
    const result = await MemoryStore.remember({ root, file: "project.md", key: "b", text: "y".repeat(50), maxChars: 60 })
    expect(result.changed).toBe(false)
    expect(result.full?.max).toBe(60)
    expect(await fs.readFile(file, "utf8")).toBe(before)
  })

  test("the limit counts all source files together", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "corrections.md", key: "c", text: "z".repeat(80) })
    const result = await MemoryStore.remember({ root, file: "project.md", key: "p", text: "y".repeat(30), maxChars: 100 })
    expect(result.changed).toBe(false)
    expect(result.full).toBeDefined()
  })

  test("replacing an entry with a shorter one is allowed even when memory is full", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "a", text: "x".repeat(80) })
    const result = await MemoryStore.remember({ root, file: "project.md", key: "a", text: "x".repeat(10), maxChars: 50 })
    expect(result.changed).toBe(true)
  })
})

describe("MemoryStore.forget", () => {
  test("an empty or whitespace query removes nothing", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "a", text: "one" })
    await MemoryStore.remember({ root, file: "corrections.md", key: "b", text: "two" })
    for (const query of ["", "   ", "\n\t"]) {
      expect(await MemoryStore.forget({ root, query })).toEqual({ removed: 0, files: [] })
    }
    expect((await MemoryStore.catalog({ root })).count).toBe(2)
  })

  test("is case-insensitive and reports each touched file", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "Alpha", text: "one" })
    await MemoryStore.remember({ root, file: "corrections.md", key: "beta", text: "ALPHA again" })
    const result = await MemoryStore.forget({ root, query: "alpha" })
    expect(result.removed).toBe(2)
    expect(result.files.sort()).toEqual(["corrections.md", "project.md"])
  })

  test("does not treat the query as a pattern", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", key: "a", text: "one" })
    expect((await MemoryStore.forget({ root, query: ".*" })).removed).toBe(0)
    expect((await MemoryStore.forget({ root, query: "[" })).removed).toBe(0)
  })

  test("forgetting from a root that does not exist is a no-op", async () => {
    const root = path.join(await tmproot(), "missing", "deeper")
    expect(await MemoryStore.forget({ root, query: "x" })).toEqual({ removed: 0, files: [] })
  })
})

describe("MemoryStore.search", () => {
  test("blank queries and non-matching queries return nothing; limit is honoured", async () => {
    const root = await tmproot()
    for (const k of ["a", "b", "c"]) await MemoryStore.remember({ root, file: "project.md", key: k, text: "common word" })
    expect(await MemoryStore.search({ root, query: "   ", limit: 5 })).toEqual([])
    expect(await MemoryStore.search({ root, query: "absent", limit: 5 })).toEqual([])
    expect(await MemoryStore.search({ root, query: "common", limit: 2 })).toHaveLength(2)
    expect(await MemoryStore.search({ root, query: "common", limit: 0 })).toEqual([])
  })

  test("a corrupt or hand-edited file does not break reads", async () => {
    const root = await tmproot()
    await fs.writeFile(MemoryPaths.source(root, "project.md"), "garbage\n- no separator\n- :: empty key\n- k :: \n- ok :: fine\n\u0000\n")
    const catalog = await MemoryStore.catalog({ root })
    expect(catalog.count).toBe(1)
    expect(catalog.bySource["project.md"]?.[0]).toMatchObject({ key: "ok", text: "fine" })
  })
})
