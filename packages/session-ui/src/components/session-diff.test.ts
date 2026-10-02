import { describe, expect, test } from "bun:test"
import { normalize, resolveFileDiff, text, type ReviewDiff } from "./session-diff"

describe("session diff", () => {
  test("renders whole-file unified patches as complete diffs", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.fileDiff.name).toBe("a.ts")
    expect(view.fileDiff.isPartial).toBe(false)
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("keeps missing final newlines from unified patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("one\ntwo")
    expect(text(view, "additions")).toBe("one\nthree")
  })

  test("renders whole-file VCS patches as complete diffs", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n",
    })

    expect(fileDiff.isPartial).toBe(false)
    expect(fileDiff.additionLines).toEqual(["one\n", "new\n"])
  })

  test("keeps ordinary leading tool patches partial", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\n+++ a.ts\n@@ -1,5 +1,5 @@\n-old\n+new\n two\n three\n four\n five\n",
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.additionLines).toEqual(["new\n", "two\n", "three\n", "four\n", "five\n"])
  })

  test("keeps separated patch hunks partial without complete file contents", () => {
    const fileDiff = resolveFileDiff({
      file: "project.ts",
      patch:
        'Index: project.ts\n===================================================================\n--- project.ts\t\n+++ project.ts\t\n@@ -1,3 +1,2 @@\n import { and } from "drizzle-orm"\n-import { sql } from "drizzle-orm"\n import { ProjectTable } from "./project.sql"\n@@ -346,3 +345,3 @@\n import { Database } from "@/storage/db"\n-import { ProjectTable } from "./project.sql"\n+import { ProjectTable } from "../project/project.sql"\n import { SessionTable } from "../session/session.sql"\n',
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.hunks).toHaveLength(2)
    expect(fileDiff.hunks[1]?.collapsedBefore).toBeGreaterThan(0)
  })

  test("renders headerless persisted patches", () => {
    const view = normalize({
      file: "a.ts",
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    })

    expect(view.fileDiff.name).toBe("a.ts")
    expect(view.fileDiff.isPartial).toBe(true)
    expect(text(view, "deletions")).toBe("old\n")
    expect(text(view, "additions")).toBe("new\n")
  })

  test("does not share headerless patch metadata between files", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n"

    expect(resolveFileDiff({ file: "a.ts", patch }).name).toBe("a.ts")
    expect(resolveFileDiff({ file: "b.ts", patch }).name).toBe("b.ts")
  })

  test("keeps capped header-only patches partial", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n",
    })

    expect(fileDiff.name).toBe("a.ts")
    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.hunks).toEqual([])
  })

  test("keeps full legacy content as a complete diff", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.fileDiff.isPartial).toBe(false)
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })

  test("ignores malformed persisted patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex ff4ceb2..65a1de0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n+add\n same\r",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("")
    expect(text(view, "additions")).toBe("")
  })

  test("supports snapshot, VCS, and legacy FileDiffInfo payloads", () => {
    const snapshotDiff: ReviewDiff = {
      file: "snapshot.ts",
      patch:
        "Index: snapshot.ts\n===================================================================\n--- snapshot.ts\t\n+++ snapshot.ts\t\n@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const vcsDiff: ReviewDiff = {
      file: "vcs.ts",
      patch:
        "diff --git a/vcs.ts b/vcs.ts\nindex 1111111..2222222 100644\n--- a/vcs.ts\n+++ b/vcs.ts\n@@ -1 +1 @@\n-vcs-old\n+vcs-new\n",
      additions: 1,
      deletions: 1,
      status: "modified",
    }
    const fileDiffInfo: ReviewDiff = {
      file: "compat.ts",
      before: "before-text\n",
      after: "after-text\n",
      additions: 1,
      deletions: 1,
      status: "modified",
    }

    const snapshotView = normalize(snapshotDiff)
    expect(snapshotView.file).toBe("snapshot.ts")
    expect(text(snapshotView, "additions")).toBe("new\n")

    const vcsView = normalize(vcsDiff)
    expect(vcsView.file).toBe("vcs.ts")
    expect(text(vcsView, "additions")).toBe("vcs-new\n")

    const compatView = normalize(fileDiffInfo)
    expect(compatView.file).toBe("compat.ts")
    expect(text(compatView, "deletions")).toBe("before-text\n")
    expect(text(compatView, "additions")).toBe("after-text\n")
  })
})
