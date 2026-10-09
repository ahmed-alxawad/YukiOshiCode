import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Worktree } from "../../src/worktree"

describe("Worktree.nativeRealPath", () => {
  test("resolves symlinks to the on-disk path", async () => {
    const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "yk-rp-"))
    try {
      const real = await fs.realpath(dir)
      await fs.mkdir(path.join(real, "a"))
      await fs.symlink(path.join(real, "a"), path.join(real, "link"))
      expect(await Worktree.nativeRealPath(path.join(real, "link"))).toBe(path.join(real, "a"))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("returns the input unchanged when the path does not exist", async () => {
    expect(await Worktree.nativeRealPath("/definitely/not/here")).toBe("/definitely/not/here")
  })
})

describe("Worktree.startCommandInvocation", () => {
  test("uses the shared shell selection and args", () => {
    const inv = Worktree.startCommandInvocation("echo hi", "/work", "/bin/bash")
    expect(inv.shell).toBe("/bin/bash")
    expect(inv.args.at(-3)).toContain('eval "echo hi"')
    expect(inv.args.at(-1)).toBe("/work")
  })

  test("non-bash shells get plain -c", () => {
    expect(Worktree.startCommandInvocation("echo hi", "/work", "/bin/sh").args).toEqual(["-c", "echo hi"])
  })
})
