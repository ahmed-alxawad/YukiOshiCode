import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { assertInCwd, resolveInCwd } from "../../src/delegate/client"

describe("delegate path containment", () => {
  const cwd = path.resolve(os.tmpdir(), "yk-incwd-project")

  test("accepts names that merely start with two dots", () => {
    expect(assertInCwd("..cache/file", cwd)).toBe(path.join(cwd, "..cache", "file"))
  })

  test("rejects real parent traversal", () => {
    expect(() => assertInCwd("..", cwd)).toThrow("outside project")
    expect(() => assertInCwd("../x", cwd)).toThrow("outside project")
    expect(() => assertInCwd("a/../../x", cwd)).toThrow("outside project")
  })

  test("resolveInCwd accepts ..cache and rejects links escaping the project", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "yk-incwd-")))
    try {
      await fs.mkdir(path.join(dir, "..cache"))
      expect(await resolveInCwd("..cache/new.txt", dir)).toBe(path.join(dir, "..cache", "new.txt"))
      if (process.platform !== "win32") {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "yk-outside-"))
        try {
          await fs.symlink(outside, path.join(dir, "link"))
          await expect(resolveInCwd("link/x", dir)).rejects.toThrow("through a link")
        } finally {
          await fs.rm(outside, { recursive: true, force: true })
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
