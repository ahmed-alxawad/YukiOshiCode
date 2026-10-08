import { describe, expect, test } from "bun:test"
import { combineFileChanges, formatFileChanges } from "@yukioshi/core/files-changed-summary"

describe("combineFileChanges", () => {
  test("combines turns per file, summing counts and keeping latest status", () => {
    const turn1 = [
      { file: "a.ts", additions: 10, deletions: 0, status: "added" as const },
      { file: "b.ts", additions: 5, deletions: 1, status: "modified" as const },
    ]
    const turn2 = [
      { file: "a.ts", additions: 4, deletions: 2, status: "modified" as const },
      { file: "c.ts", additions: 8, deletions: 0, status: "added" as const },
    ]
    const combined = combineFileChanges(turn1, turn2)
    expect(combined).toEqual([
      { file: "a.ts", additions: 14, deletions: 2, status: "modified" },
      { file: "b.ts", additions: 5, deletions: 1, status: "modified" },
      { file: "c.ts", additions: 8, deletions: 0, status: "added" },
    ])
  })

  test("handles undefined and empty change sets", () => {
    const turn = [{ file: "x.ts", additions: 1, deletions: 0, status: "added" as const }]
    expect(combineFileChanges(undefined, turn, [], undefined)).toEqual([
      { file: "x.ts", additions: 1, deletions: 0, status: "added" },
    ])
  })

  test("returns empty array when no changes", () => {
    expect(combineFileChanges([], [])).toEqual([])
    expect(combineFileChanges()).toEqual([])
  })
})

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
