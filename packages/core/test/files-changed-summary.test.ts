import { describe, expect, test } from "bun:test"
import { formatFileChanges } from "@yukioshi/core/files-changed-summary"

describe("formatFileChanges", () => {
  test("sorts files and labels additions and deletions", () => {
    expect(
      formatFileChanges([
        { file: "old.ts", additions: 0, deletions: 5, status: "deleted" },
        { file: "src/b.ts", additions: 12, deletions: 0, status: "added" },
        { file: "src/a.ts", additions: 30, deletions: 2, status: "modified" },
      ]),
    ).toBe(
      ["Changed 3 files  +42 −7", "  old.ts (deleted)  −5", "  src/a.ts  +30 −2", "  src/b.ts (new)  +12"].join("\n"),
    )
  })

  test("truncates after eight files", () => {
    const changes = Array.from({ length: 9 }, (_, index) => ({
      file: `file-${index}.ts`,
      additions: 1,
      deletions: 0,
    }))
    expect(formatFileChanges(changes)).toContain("  … and 1 more")
    expect(formatFileChanges(changes).split("\n")).toHaveLength(10)
  })

  test("returns nothing for a zero-change turn", () => {
    expect(formatFileChanges([])).toBe("")
  })
})
