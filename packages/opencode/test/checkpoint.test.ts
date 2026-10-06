import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoint"

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

describe("git checkpoints", () => {
  test("commits the worktree on a separate ref without changing HEAD or the index", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yukioshi-checkpoint-test-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")
    writeFileSync(path.join(directory, "file.txt"), "one")
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")
    const head = git(directory, "rev-parse", "HEAD")
    writeFileSync(path.join(directory, "staged.txt"), "staged")
    git(directory, "add", "staged.txt")
    writeFileSync(path.join(directory, "file.txt"), "two")

    const checkpoint = createCheckpoint({ directory, sessionID: "ses_test", prompt: "change files" })!
    expect(checkpoint.turn).toBe(1)
    expect(git(directory, "rev-parse", "HEAD")).toBe(head)
    expect(git(directory, "diff", "--cached", "--name-only")).toBe("staged.txt")
    expect(git(directory, "rev-parse", "refs/yukioshi/checkpoints/ses_test")).toBe(checkpoint.id)
    expect(listCheckpoints(directory, "ses_test")).toHaveLength(1)
  })

  test("restore makes a safety checkpoint and restores the selected tree", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yukioshi-checkpoint-restore-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")
    writeFileSync(path.join(directory, "file.txt"), "first")
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")
    writeFileSync(path.join(directory, "file.txt"), "checkpoint")
    const checkpoint = createCheckpoint({ directory, sessionID: "ses_restore", prompt: "checkpoint this" })!
    writeFileSync(path.join(directory, "file.txt"), "current")

    restoreCheckpoint({ directory, id: checkpoint.id, sessionID: "ses_safety", yes: true })
    expect(readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("checkpoint")
    expect(listCheckpoints(directory, "ses_safety").length).toBe(1)
  })
})
