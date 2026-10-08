import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, closeSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoint"

const base = mkdtempSync(path.join(process.env.TMPDIR ?? "/var/tmp", "yk-cpcorner-"))
afterAll(() => rmSync(base, { recursive: true, force: true }), 60_000)

// Isolated git environment: no user/system config, so the host's identity or hooks never leak in.
const home = path.join(base, "home")
mkdirSync(home, { recursive: true })
const isolated: Record<string, string> = {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, ...isolated } }).trim()
}

function identified(cwd: string, ...args: string[]) {
  return git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args)
}

let counter = 0
function repo(init = true) {
  const dir = path.join(base, `r${counter++}`)
  mkdirSync(dir, { recursive: true })
  if (init) {
    git(dir, "init", "-q", "-b", "main")
    writeFileSync(path.join(dir, "file.txt"), "one")
    git(dir, "add", ".")
    identified(dir, "commit", "-qm", "initial")
  }
  return dir
}

// All checkpoint calls run with the isolated environment (the code under test inherits process.env).
function withIsolatedEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(isolated)) saved[key] = process.env[key]
  Object.assign(process.env, isolated)
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("checkpoint corners", () => {
  test("a. never runs git hooks (pre-commit in .git/hooks or core.hooksPath)", () => {
    const dir = repo()
    const marker = path.join(base, "hook-ran")
    const scriptFor = (name: string) => `#!/bin/sh\necho "$0" >> "${marker}"\nexit 1\n`
    for (const name of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit", "pre-merge-commit", "post-index-change"]) {
      const file = path.join(dir, ".git", "hooks", name)
      writeFileSync(file, scriptFor(name))
      chmodSync(file, 0o755)
    }
    const hooksDir = path.join(base, "custom-hooks")
    mkdirSync(hooksDir, { recursive: true })
    for (const name of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit", "reference-transaction", "post-index-change"]) {
      const file = path.join(hooksDir, name)
      writeFileSync(file, scriptFor(name))
      chmodSync(file, 0o755)
    }
    // The pre-commit hook really would run for an ordinary commit in this setup (control).
    writeFileSync(path.join(dir, "control.txt"), "x")
    git(dir, "add", "control.txt")
    expect(() => identified(dir, "commit", "-qm", "control")).toThrow()
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    writeFileSync(path.join(dir, "file.txt"), "changed")
    withIsolatedEnv(() => {
      const hooksPathFirst = createCheckpoint({ directory: dir, sessionID: "ses_hook", prompt: "p" })
      expect(hooksPathFirst).toBeDefined()
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("")
      git(dir, "config", "core.hooksPath", hooksDir)
      writeFileSync(path.join(dir, "file.txt"), "changed again")
      const second = createCheckpoint({ directory: dir, sessionID: "ses_hook", prompt: "p2" })
      expect(second?.turn).toBe(2)
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("")
    })
  })

  test("b. a repository with a submodule: does not hang, fetch or fail; captures the gitlink and plain files", () => {
    const bare = path.join(base, "sub.git")
    git(base, "init", "-q", "--bare", "-b", "main", bare)
    const seed = repo()
    writeFileSync(path.join(seed, "lib.txt"), "lib")
    git(seed, "add", ".")
    identified(seed, "commit", "-qm", "lib")
    git(seed, "push", "-q", bare, "main")

    const dir = repo()
    git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", bare, "vendor/lib")
    identified(dir, "commit", "-qm", "add submodule")
    // Dirty state: change inside the submodule (untracked + modified) and a new file in the parent.
    writeFileSync(path.join(dir, "vendor/lib/new-in-sub.txt"), "sub change")
    writeFileSync(path.join(dir, "vendor/lib/lib.txt"), "modified in sub")
    writeFileSync(path.join(dir, "parent-new.txt"), "parent")

    const started = Date.now()
    const created = withIsolatedEnv(() => createCheckpoint({ directory: dir, sessionID: "ses_sub", prompt: "sub" }))
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(created).toBeDefined()
    const tree = git(dir, "ls-tree", "-r", created!.id)
    // The submodule is recorded as a gitlink (mode 160000) pinned to its commit; its inner files are not captured.
    const subHead = git(path.join(dir, "vendor/lib"), "rev-parse", "HEAD")
    expect(tree).toContain(`160000 commit ${subHead}\tvendor/lib`)
    expect(tree).not.toContain("new-in-sub.txt")
    expect(tree).toContain("parent-new.txt")
    expect(tree).toContain(".gitmodules")
    // The submodule's own repository was not touched: its HEAD is unchanged and it has no checkpoint ref.
    expect(git(path.join(dir, "vendor/lib"), "for-each-ref", "refs/yukioshi")).toBe("")
    expect(withIsolatedEnv(() => listCheckpoints(dir, "ses_sub")).length).toBe(1)
  })

  test("c. a linked worktree (.git is a file)", () => {
    const main = repo()
    const linked = path.join(base, "linked")
    git(main, "worktree", "add", "-q", linked, "-b", "feature")
    expect(existsSync(path.join(linked, ".git"))).toBe(true)
    expect(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: linked, encoding: "utf8", env: { ...process.env, ...isolated } }).trim()).toContain(
      "worktrees",
    )
    writeFileSync(path.join(linked, "file.txt"), "linked change")
    writeFileSync(path.join(linked, "added.txt"), "added")
    const created = withIsolatedEnv(() => createCheckpoint({ directory: linked, sessionID: "ses_wt", prompt: "wt" }))
    expect(created).toBeDefined()
    expect(git(linked, "show", `${created!.id}:file.txt`)).toBe("linked change")
    expect(git(linked, "show", `${created!.id}:added.txt`)).toBe("added")
    const second = withIsolatedEnv(() => {
      writeFileSync(path.join(linked, "added.txt"), "added 2")
      return createCheckpoint({ directory: linked, sessionID: "ses_wt", prompt: "wt2" })
    })
    expect(second?.turn).toBe(2)
    expect(withIsolatedEnv(() => listCheckpoints(linked, "ses_wt")).length).toBe(2)
    // The ref is shared by the repository, so it is visible from the main checkout too.
    expect(git(main, "rev-parse", "refs/yukioshi/checkpoints/ses_wt")).toBe(second!.id)
  })

  test("e. works when git has no user.name or user.email", () => {
    const dir = repo()
    expect(() => git(dir, "config", "--get", "user.name")).toThrow()
    expect(() => git(dir, "config", "--get", "user.email")).toThrow()
    writeFileSync(path.join(dir, "file.txt"), "changed")
    const created = withIsolatedEnv(() => createCheckpoint({ directory: dir, sessionID: "ses_noid", prompt: "p" }))
    expect(created).toBeDefined()
    expect(git(dir, "show", "-s", "--format=%an <%ae>", created!.id)).toBe("YukiOshi <checkpoint@yukioshi.invalid>")
    // Repeat in a fresh repository that has no commits and no identity at all.
    const empty = repo(false)
    git(empty, "init", "-q", "-b", "main")
    writeFileSync(path.join(empty, "a.txt"), "a")
    const first = withIsolatedEnv(() => createCheckpoint({ directory: empty, sessionID: "ses_noid2", prompt: "p" }))
    expect(first?.turn).toBe(1)
  })

  test("restore brings back a file larger than 1 MB byte for byte", () => {
    const dir = repo()
    const big = Buffer.alloc(5 * 1024 * 1024, "abc")
    writeFileSync(path.join(dir, "big.txt"), big)
    const created = withIsolatedEnv(() => createCheckpoint({ directory: dir, sessionID: "ses_rs", prompt: "p" }))
    writeFileSync(path.join(dir, "big.txt"), "other")
    withIsolatedEnv(() => restoreCheckpoint({ directory: dir, id: created!.id.slice(0, 12), yes: true, sessionID: "ses_rs" }))
    expect(readFileSync(path.join(dir, "big.txt")).equals(big)).toBe(true)
  })

  test("d. big repository: 20,000 small files plus one 200 MB file", () => {
    const dir = repo()
    const many = path.join(dir, "many")
    for (let d = 0; d < 200; d++) {
      const sub = path.join(many, `dir-with-a-fairly-long-name-${d}`)
      mkdirSync(sub, { recursive: true })
      for (let f = 0; f < 100; f++) writeFileSync(path.join(sub, `small-file-number-${f}.txt`), `${d}:${f}\n`)
    }
    const bigPath = path.join(dir, "big.bin")
    const fd = openSync(bigPath, "w")
    ftruncateSync(fd, 200 * 1024 * 1024)
    closeSync(fd)

    const rssBefore = process.memoryUsage().rss
    const started = Date.now()
    const created = withIsolatedEnv(() => createCheckpoint({ directory: dir, sessionID: "ses_big", prompt: "big" }))
    const elapsed = Date.now() - started
    const rssAfter = process.memoryUsage().rss
    console.log(`[d] first checkpoint: ${elapsed} ms, rss ${Math.round(rssBefore / 1e6)} -> ${Math.round(rssAfter / 1e6)} MB`)
    expect(created).toBeDefined()
    expect(git(dir, "cat-file", "-s", `${created!.id}:big.bin`)).toBe(String(200 * 1024 * 1024))
    expect(git(dir, "ls-tree", "-r", "--name-only", created!.id).split("\n").length).toBe(20_000 + 2)

    // Second checkpoint after a small edit should reuse the index of the previous commit and stay fast.
    writeFileSync(path.join(dir, "file.txt"), "edit")
    const started2 = Date.now()
    const second = withIsolatedEnv(() => createCheckpoint({ directory: dir, sessionID: "ses_big", prompt: "big2" }))
    console.log(`[d] second checkpoint: ${Date.now() - started2} ms`)
    expect(second?.turn).toBe(2)
    // Listing works on a tree this size.
    expect(withIsolatedEnv(() => listCheckpoints(dir, "ses_big")).length).toBe(2)
    // Memory stays bounded: the 200 MB file is streamed by git, not read into this process.
    expect(rssAfter - rssBefore).toBeLessThan(150 * 1024 * 1024)
  }, 120_000)
})
