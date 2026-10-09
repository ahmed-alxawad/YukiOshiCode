import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCheckpoint, restoreCheckpoint } from "../src/checkpoint"

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

describe("checkpoint restore fidelity", () => {
  test("restores non-ASCII filenames correctly", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yk-cp-utf8-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")

    const nonAsciiName = "résumé_日本語_тест.md"
    writeFileSync(path.join(directory, nonAsciiName), "content v1")
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")

    const cp = createCheckpoint({ directory, sessionID: "ses_utf8", prompt: "first", force: true })
    expect(cp).toBeDefined()

    // Corrupt the non-ASCII file
    writeFileSync(path.join(directory, nonAsciiName), "corrupted v2")
    restoreCheckpoint({ directory, id: cp!.id.slice(0, 12), sessionID: "ses_safety", yes: true })

    expect(readFileSync(path.join(directory, nonAsciiName), "utf8")).toBe("content v1")
    rmSync(directory, { recursive: true, force: true })
  })

  test("preserves executable bit on restored files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yk-cp-exec-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")

    const script = path.join(directory, "run.sh")
    writeFileSync(script, "#!/bin/sh\necho ok\n")
    chmodSync(script, 0o755)
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")

    const cp = createCheckpoint({ directory, sessionID: "ses_exec", prompt: "executable", force: true })
    expect(cp).toBeDefined()

    // Strip executable bit
    chmodSync(script, 0o644)
    expect((statSync(script).mode & 0o111) === 0).toBe(true)

    restoreCheckpoint({ directory, id: cp!.id.slice(0, 12), sessionID: "ses_safety", yes: true })

    // Executable bit must be restored
    expect((statSync(script).mode & 0o111) !== 0).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  })

  test("preserves and restores symbolic links", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yk-cp-symlink-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")

    writeFileSync(path.join(directory, "target.txt"), "target file")
    symlinkSync("target.txt", path.join(directory, "link.txt"))
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")

    const cp = createCheckpoint({ directory, sessionID: "ses_sym", prompt: "symlink", force: true })
    expect(cp).toBeDefined()

    // Replace link with regular file
    rmSync(path.join(directory, "link.txt"))
    writeFileSync(path.join(directory, "link.txt"), "regular file")
    expect(lstatSync(path.join(directory, "link.txt")).isSymbolicLink()).toBe(false)

    restoreCheckpoint({ directory, id: cp!.id.slice(0, 12), sessionID: "ses_safety", yes: true })

    // Must be restored as an actual symbolic link
    const stat = lstatSync(path.join(directory, "link.txt"))
    expect(stat.isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(directory, "link.txt"))).toBe("target.txt")
    rmSync(directory, { recursive: true, force: true })
  })

  test("does not turn CRLF files into LF", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "yk-cp-crlf-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Test")
    git(directory, "config", "user.email", "test@example.invalid")
    git(directory, "config", "core.autocrlf", "false")

    const crlfFile = path.join(directory, "dos.txt")
    const crlfContent = "line1\r\nline2\r\nline3\r\n"
    writeFileSync(crlfFile, crlfContent)
    git(directory, "add", ".")
    git(directory, "commit", "-qm", "initial")

    const cp = createCheckpoint({ directory, sessionID: "ses_crlf", prompt: "crlf", force: true })
    expect(cp).toBeDefined()

    // Replace with LF
    writeFileSync(crlfFile, "line1\nline2\nline3\n")
    restoreCheckpoint({ directory, id: cp!.id.slice(0, 12), sessionID: "ses_safety", yes: true })

    const restored = readFileSync(crlfFile, "utf8")
    expect(restored).toBe(crlfContent)
    expect(restored.includes("\r\n")).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  })
})
