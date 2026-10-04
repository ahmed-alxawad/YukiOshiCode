import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promptText } from "../../src/memory"
import { MemoryStore } from "../../src/memory/store"

describe("memory size limit", () => {
  test("refuses a save that would grow memory past max_chars, but allows replacing with a shorter entry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-limit-"))
    const save = (file: "project.md" | "corrections.md", key: string, text: string) =>
      MemoryStore.remember({ root, file, key, text, maxChars: 100 })

    expect((await save("project.md", "a", "x".repeat(40))).changed).toBe(true)
    expect((await save("corrections.md", "b", "y".repeat(40))).changed).toBe(true)
    expect(await MemoryStore.used(root)).toBe(82)

    expect(await save("project.md", "c", "z".repeat(40))).toEqual({
      key: "c",
      changed: false,
      full: { used: 82, max: 100 },
    })
    expect(await MemoryStore.used(root)).toBe(82)

    // Merging: a shorter entry under an existing key always fits.
    expect((await save("project.md", "a", "short")).changed).toBe(true)
    expect(await MemoryStore.used(root)).toBe(47)
  })
})

describe("memory in the system prompt", () => {
  test("lists corrections first, and nothing when memory is empty", () => {
    expect(promptText({}, 4000)).toBeUndefined()
    const text = promptText(
      {
        "project.md": [{ key: "run", text: "bun dev starts the app" }],
        "corrections.md": [{ key: "tabs", text: "use two spaces, not tabs" }],
      },
      4000,
    )!
    expect(text).toStartWith("<project_memory>")
    expect(text.indexOf("## Corrections")).toBeLessThan(text.indexOf("## Facts"))
    expect(text).toContain("- tabs :: use two spaces, not tabs")
  })

  test("cuts memory edited past its limit and says so", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, text: "x".repeat(20) }))
    const text = promptText({ "project.md": entries }, 100)!
    expect(text.match(/^- k/gm)?.length).toBe(4)
    expect(text).toContain("over its size limit")
  })
})
