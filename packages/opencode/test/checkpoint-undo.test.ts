import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { autoCommitTurn, beginTurn, createCheckpoint, undoLastTurn } from "../src/checkpoint"

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
    expect(() => undoLastTurn({ directory: dir, sessionID: "s" })).toThrow(/Nothing more to undo in session s/)
    rmSync(dir, { recursive: true, force: true })
  })

  test("repeated undo steps back one more turn each time, as /undo turns do", () => {
    const dir = repo()
    const turn = (content?: string) => {
      beginTurn({ directory: dir, sessionID: "s" })
      if (content) writeFileSync(file(dir, "a.txt"), content)
      else undoLastTurn({ directory: dir, sessionID: "s" })
      return createCheckpoint({ directory: dir, sessionID: "s", prompt: content ?? "Undo the last turn's file changes" })
    }
    turn("turn1")
    turn("turn2")
    expect(turn()).toBeUndefined()
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("turn1")
    expect(turn()).toBeUndefined()
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a0")
    expect(() => turn()).toThrow(/Nothing more to undo in session s/)
    rmSync(dir, { recursive: true, force: true })
  })

  test("undoes the given session, and without one the newest session but never a safety checkpoint", async () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "mine")
    createCheckpoint({ directory: dir, sessionID: "ses_mine", prompt: "my turn" })
    await Bun.sleep(1100) // checkpoint times are in seconds
    beginTurn({ directory: dir, sessionID: "ses_other" })
    writeFileSync(file(dir, "b.txt"), "other")
    createCheckpoint({ directory: dir, sessionID: "ses_other", prompt: "other turn" })
    await Bun.sleep(1100)
    writeFileSync(file(dir, "b.txt"), "other 2")
    createCheckpoint({ directory: dir, sessionID: "ses_other", prompt: "other turn 2" })
    await Bun.sleep(1100)
    const undone = undoLastTurn({ directory: dir, sessionID: "ses_other" })
    expect(undone.sessionID).toBe("ses_other")
    expect(readFileSync(file(dir, "b.txt"), "utf8")).toBe("other")
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("mine")
    // The newest checkpoint now is the `ses_other-undo` safety one; the default must skip it.
    const fallback = undoLastTurn({ directory: dir })
    expect(fallback.sessionID).toBe("ses_other")
    expect(existsSync(file(dir, "b.txt"))).toBe(false)
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("mine")
    undoLastTurn({ directory: dir, sessionID: "ses_mine" })
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a0")
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

  test("undoing the first turn keeps the user's uncommitted edits and untracked files", () => {
    const dir = repo()
    writeFileSync(file(dir, "readme.md"), "readme")
    git(dir, "add", "readme.md")
    git(dir, "commit", "-qm", "readme")
    writeFileSync(file(dir, "readme.md"), "readme\nuser work in progress")
    writeFileSync(file(dir, "notes-secret.txt"), "API_KEY=sk-live-123")
    beginTurn({ directory: dir, sessionID: "s" })
    writeFileSync(file(dir, "a.txt"), "agent")
    const cp = createCheckpoint({ directory: dir, sessionID: "s", prompt: "fix a" })!
    expect(git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", cp.id)).toBe("a.txt")
    autoCommitTurn({ directory: dir, checkpointID: cp.id, prompt: "fix a" })
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt")
    undoLastTurn({ directory: dir, sessionID: "s" })
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("a0")
    expect(readFileSync(file(dir, "readme.md"), "utf8")).toBe("readme\nuser work in progress")
    expect(readFileSync(file(dir, "notes-secret.txt"), "utf8")).toBe("API_KEY=sk-live-123")
    expect(() => undoLastTurn({ directory: dir, sessionID: "s" })).toThrow(/Nothing more to undo/)
    rmSync(dir, { recursive: true, force: true })
  })

  test("auto-commit refuses a file that already had the user's uncommitted edits", () => {
    const dir = repo()
    writeFileSync(file(dir, "a.txt"), "user edit")
    beginTurn({ directory: dir, sessionID: "s" })
    writeFileSync(file(dir, "a.txt"), "user edit\nagent edit")
    const cp = createCheckpoint({ directory: dir, sessionID: "s", prompt: "turn" })!
    const head = git(dir, "rev-parse", "HEAD")
    expect(() => autoCommitTurn({ directory: dir, checkpointID: cp.id, prompt: "turn" })).toThrow(
      /a\.txt had uncommitted changes before this turn/,
    )
    expect(git(dir, "rev-parse", "HEAD")).toBe(head)
    undoLastTurn({ directory: dir, sessionID: "s" })
    expect(readFileSync(file(dir, "a.txt"), "utf8")).toBe("user edit")
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
