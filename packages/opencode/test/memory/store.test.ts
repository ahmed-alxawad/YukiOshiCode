import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { MemoryMarkdown } from "../../src/memory/markdown"
import { MemorySlug } from "../../src/memory/slug"
import { MemoryStore } from "../../src/memory/store"

async function tmproot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "memory-store-"))
}

describe("MemoryMarkdown", () => {
  test("parse reads key :: text lines under headings", () => {
    const text = "## Facts\n- a :: first\n- b :: second\n"
    expect(MemoryMarkdown.parse(text)).toEqual([
      { section: "Facts", key: "a", text: "first" },
      { section: "Facts", key: "b", text: "second" },
    ])
  })

  test("upsert creates a heading and appends when absent", () => {
    const result = MemoryMarkdown.upsert({ text: "", section: "Facts", line: MemoryMarkdown.line("a", "first") })
    expect(result.changed).toBe(true)
    expect(MemoryMarkdown.parse(result.text)).toEqual([{ section: "Facts", key: "a", text: "first" }])
  })

  test("upsert replaces an existing key in place", () => {
    const base = "## Facts\n- a :: first\n"
    const result = MemoryMarkdown.upsert({ text: base, section: "Facts", line: MemoryMarkdown.line("a", "updated") })
    expect(MemoryMarkdown.parse(result.text)).toEqual([{ section: "Facts", key: "a", text: "updated" }])
  })

  test("remove drops matching entries and keeps the rest", () => {
    const base = "## Facts\n- a :: first\n- b :: second\n"
    const result = MemoryMarkdown.remove({ text: base, match: (entry) => entry.key === "a" })
    expect(result.count).toBe(1)
    expect(MemoryMarkdown.parse(result.text)).toEqual([{ section: "Facts", key: "b", text: "second" }])
  })
})

describe("MemorySlug", () => {
  test("safe slugifies and falls back on empty input", () => {
    expect(MemorySlug.safe("Hello World!", { max: 80, fallback: "note", lower: true })).toBe("hello_world")
    expect(MemorySlug.safe("   ", { max: 80, fallback: "note" })).toBe("note")
  })
})

describe("MemoryStore", () => {
  test("remember writes a project.md entry with an auto key", async () => {
    const root = await tmproot()
    const result = await MemoryStore.remember({ root, file: "project.md", text: "Uses pnpm workspaces" })
    expect(result.changed).toBe(true)
    const text = await MemoryStore.readSource(root, "project.md")
    expect(text).toContain(result.key)
    expect(text).toContain("Uses pnpm workspaces")
  })

  test("remember with an explicit key upserts in place", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "v1", key: "build-tool" })
    const second = await MemoryStore.remember({ root, file: "project.md", text: "v2", key: "build-tool" })
    expect(second.key).toBe("build-tool")
    const entries = MemoryMarkdown.parse(await MemoryStore.readSource(root, "project.md"))
    expect(entries).toEqual([{ section: "Facts", key: "build-tool", text: "v2" }])
  })

  test("correct writes into corrections.md, not project.md", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "corrections.md", text: "Use bun, not npm", key: "pkg-manager" })
    expect(await MemoryStore.readSource(root, "project.md")).toBe("")
    expect(await MemoryStore.readSource(root, "corrections.md")).toContain("Use bun, not npm")
  })

  test("forget removes a matching entry by key across all source files", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "fact", key: "k1" })
    await MemoryStore.remember({ root, file: "corrections.md", text: "fix", key: "k1" })
    const result = await MemoryStore.forget({ root, query: "k1" })
    expect(result.removed).toBe(2)
    expect(result.files.sort()).toEqual(["corrections.md", "project.md"])
    expect(MemoryMarkdown.parse(await MemoryStore.readSource(root, "project.md"))).toEqual([])
  })

  test("forget matches by substring in the text when the key doesn't match", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "Deploys via GitHub Actions", key: "deploy" })
    const result = await MemoryStore.forget({ root, query: "github actions" })
    expect(result.removed).toBe(1)
  })

  test("search ranks entries by matching term count", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "Uses TypeScript and Bun", key: "stack" })
    await MemoryStore.remember({ root, file: "project.md", text: "Uses TypeScript only", key: "lang" })
    await MemoryStore.remember({ root, file: "project.md", text: "Unrelated note", key: "other" })
    const hits = await MemoryStore.search({ root, query: "typescript bun", limit: 5 })
    expect(hits.length).toBe(2)
    expect(hits[0]?.key).toBe("stack")
  })

  test("search returns nothing for an unmatched query", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "Uses TypeScript", key: "stack" })
    expect(await MemoryStore.search({ root, query: "rust", limit: 5 })).toEqual([])
  })

  test("catalog lists entries grouped by source and respects a filter", async () => {
    const root = await tmproot()
    await MemoryStore.remember({ root, file: "project.md", text: "Monorepo with bun workspaces", key: "structure" })
    await MemoryStore.remember({ root, file: "environment.md", text: "CI runs on Linux", key: "ci" })
    const all = await MemoryStore.catalog({ root })
    expect(all.count).toBe(2)
    expect(Object.keys(all.bySource).sort()).toEqual(["environment.md", "project.md"])

    const filtered = await MemoryStore.catalog({ root, query: "linux" })
    expect(filtered.count).toBe(1)
    expect(Object.keys(filtered.bySource)).toEqual(["environment.md"])
  })

  test("concurrent remember calls on the same root don't lose writes", async () => {
    const root = await tmproot()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        MemoryStore.remember({ root, file: "project.md", text: `fact ${i}`, key: `k${i}` }),
      ),
    )
    const entries = MemoryMarkdown.parse(await MemoryStore.readSource(root, "project.md"))
    expect(entries.length).toBe(10)
  })
})
