import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { trustedPwd } from "../../src/cli/cmd/run"

describe("run working directory", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yk-pwd-")))
  const project = path.join(base, "project")
  const other = path.join(base, "other")
  fs.mkdirSync(project)
  fs.mkdirSync(other)

  test("a stale PWD from the parent process loses to the real cwd", () => {
    expect(trustedPwd(other, project)).toBe(project)
  })

  test("a missing or unusable PWD falls back to the cwd", () => {
    expect(trustedPwd(undefined, project)).toBe(project)
    expect(trustedPwd(path.join(base, "gone"), project)).toBe(project)
  })

  test("PWD that names the same directory is kept", () => {
    expect(trustedPwd(project, project)).toBe(project)
    if (process.platform === "win32") return
    const link = path.join(base, "link")
    fs.symlinkSync(project, link, "dir")
    expect(trustedPwd(link, project)).toBe(link)
  })
})
