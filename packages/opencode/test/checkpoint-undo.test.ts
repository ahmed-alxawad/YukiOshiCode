import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { autoCommitTurn, createCheckpoint, undoLastTurn } from "../src/checkpoint"

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function repo(subjects: string[] = ["initial"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "yk-undo-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.name", "Test")
  git(dir, "config", "user.email", "test@example.invalid")
  writeFileSync(path.join(dir, "a.txt"), "a0")
  git(dir, "add", ".")
  for (const s of subjects) git(dir, "commit", "-q", "--allow-empty", "-m", s)
  return dir
}

const file = (dir: string, name: string) => path.join(dir, name)

describe("undo last turn", () => {
  test("restores only the last turn's changes", () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "a1")
    createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn one" })
    writeFileSync(file(dir, "a.txt"), "a2")
    writeFileSync(file(dir, "new.txt"), "n")
    createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn two" })
    undoLastTurn({ directory: dir, sessionID: "s" })
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a1")
    expect(existsSync(file(dir, "new.txt"))).toBe(false)
    undoLastTurn({ directory: dir, sessionID: "s" })
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a0")
    expect(() => undoLastTurn({ directory: dir, sessionID: "s" })).toThrow(/Nothing to undo/)
    rmSync(dir, { recursive: true, force: true })
  })

  test("refuses when files changed since the turn", () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "a1")
    createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn" })
    writeFileSync(file(dir, "a.txt"), "user edit")
    expect(() => undoLastTurn({ directory: dir, sessionID: "s" })).toThrow(/changed since/)
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("user edit")
    rmSync(dir, { recursive: true, force: true })
  })

  test("auto-commit commits the turn's files, in the repo style, and undo drops it", () => {
    const dir = repo(["feat: one", "fix: two"])
    writeFileSync(file(dir, "a.txt"), "a1")
    const cp = createCheckpoint({ directory: dir, sessionID: "s", prompt: "Fix the Thing\nmore" })!
    const before = git(dir, "rev-parse", "HEAD")
    autoCommitTurn({ directory: dir, checkpointID: cp.id, prompt: "Fix the Thing\nmore" })
    expect(git(dir, "log", "-1", "--format=%s")).toBe("chore: fix the Thing")
    expect(git(dir, "log", "-1", "--format=%B")).toContain("YukiOshi-Auto-Commit:")
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt")
    const result = undoLastTurn({ directory: dir, sessionID: "s" })
    expect(result.droppedCommit).toBe(true)
    expect(git(dir, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a0")
    rmSync(dir, { recursive: true, force: true })
  })

  test("never drops a pushed auto-commit", () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "a1")
    const cp = createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn" })!
    autoCommitTurn({ directory: dir, checkpointID: cp.id, prompt: "turn" })
    const head = git(dir, "rev-parse", "HEAD")
    git(dir, "update-ref", "refs/remotes/origin/main", head)
    expect(() => undoLastTurn({ directory: dir, sessionID: "s" })).toThrow(/pushed/)
    expect(git(dir, "rev-parse", "HEAD")).toBe(head)
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a1")
    rmSync(dir, { recursive: true, force: true })
  })

  test("leaves a commit of the user's own alone", () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "a1")
    createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn" })
    git(dir, "commit", "-qam", "my own commit")
    const head = git(dir, "rev-parse", "HEAD")
    const result = undoLastTurn({ directory: dir, sessionID: "s" })
    expect(result.droppedCommit).toBe(false)
    expect(git(dir, "rev-parse", "HEAD")).toBe(head)
    rmSync(dir, { recursive: true, force: true })
  })
})
