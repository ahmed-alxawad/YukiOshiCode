import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createCheckpoint,
  listCheckpoints,
  resolveCheckpoint,
  resolveCheckpointID,
  restoreCheckpoint,
  showCheckpoint,
} from "../src/checkpoint"

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
    expect(() => resolveCheckpoint(directory, head.slice(0, 12))).toThrow("Checkpoint not found")
  })

  test("accepts list prefixes and a safety checkpoint can recover dirty work", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yukioshi-checkpoint-restore-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")
    writeFileSync(path.join(directory, "file.txt"), "first")
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")
    writeFileSync(path.join(directory, "file.txt"), "first checkpoint")
    const first = createCheckpoint({ directory, sessionID: "ses_restore", prompt: "first checkpoint" })!
    writeFileSync(path.join(directory, "file.txt"), "second checkpoint")
    createCheckpoint({ directory, sessionID: "ses_restore", prompt: "second checkpoint" })!
    writeFileSync(path.join(directory, "file.txt"), "dirty change")

    expect(resolveCheckpoint(directory, first.id.slice(0, 12))).toBe(first.id)
    expect(showCheckpoint(directory, first.id.slice(0, 12))).toContain("first checkpoint")
    restoreCheckpoint({ directory, id: first.id.slice(0, 12), sessionID: "ses_safety", yes: true })
    expect(readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("first checkpoint")
    expect(listCheckpoints(directory)).toHaveLength(3)

    const safety = listCheckpoints(directory, "ses_safety")[0]!
    expect(safety.message).toContain("Before restoring")
    restoreCheckpoint({ directory, id: safety.id.slice(0, 12), sessionID: "ses_restore_safety", yes: true })
    expect(readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("dirty change")
  })

  test("refuses to overwrite dirty work without confirmation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yukioshi-checkpoint-refuse-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")
    writeFileSync(path.join(directory, "file.txt"), "initial")
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")
    writeFileSync(path.join(directory, "file.txt"), "checkpoint")
    const checkpoint = createCheckpoint({ directory, sessionID: "ses_refuse", prompt: "checkpoint" })!
    writeFileSync(path.join(directory, "file.txt"), "do not lose")
    const before = listCheckpoints(directory).length

    expect(() => restoreCheckpoint({ directory, id: checkpoint.id.slice(0, 12), sessionID: "ses_safety" })).toThrow(
      "Unsaved changes exist",
    )
    expect(readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("do not lose")
    expect(listCheckpoints(directory)).toHaveLength(before)
  })

  test("rejects short, unknown, user-owned, and ambiguous ids", () => {
    const ids = [{ id: "abcdef0123456789012345678901234567890123" }, { id: "abcdef0fedcba987654321098765432109876543" }]
    expect(() => resolveCheckpointID(ids, "abcdef")).toThrow("at least 7")
    expect(() => resolveCheckpointID(ids, "deadbee")).toThrow("Checkpoint not found")
    expect(() => resolveCheckpointID(ids, "abcdef0")).toThrow("ambiguous")
  })
})
