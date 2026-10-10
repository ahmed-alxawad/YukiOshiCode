import { describe, expect, test } from "bun:test"
import { FSUtil } from "@yukioshi/core/fs-util"
import { containsPath, type InstanceContext } from "../../src/project/instance-context"

const ctx = (directory: string, worktree: string) => ({ directory, worktree, project: {} as never }) as InstanceContext

describe("FSUtil.contains traversal and lookalikes", () => {
  test("dot-dot segments are resolved before comparing", () => {
    expect(FSUtil.contains("/a/b", "/a/b/../c")).toBe(false)
    expect(FSUtil.contains("/a/b", "/a/b/c/../../c")).toBe(false)
    expect(FSUtil.contains("/a/b", "/a/b/c/../d")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a/b/..")).toBe(false)
    expect(FSUtil.contains("/a/b/../b", "/a/b/x")).toBe(true)
  })

  test("sibling directories sharing a prefix are outside", () => {
    expect(FSUtil.contains("/a/b", "/a/b2")).toBe(false)
    expect(FSUtil.contains("/a/b", "/a/b-backup/x")).toBe(false)
    expect(FSUtil.contains("/a/b", "/a/bb")).toBe(false)
  })

  test("a child whose name merely starts with two dots is inside", () => {
    expect(FSUtil.contains("/a/b", "/a/b/..hidden")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a/b/..hidden/x")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a/b/...")).toBe(true)
  })

  test("trailing separators and repeated separators do not matter", () => {
    expect(FSUtil.contains("/a/b/", "/a/b/c")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a/b/")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a//b///c")).toBe(true)
    expect(FSUtil.contains("/a/b", "/a//c")).toBe(false)
  })

  test("the filesystem root contains everything and nothing contains the root", () => {
    expect(FSUtil.contains("/", "/etc/passwd")).toBe(true)
    expect(FSUtil.contains("/a", "/")).toBe(false)
  })

  test("case is significant on POSIX", () => {
    if (process.platform === "win32") return
    expect(FSUtil.contains("/a/b", "/a/B/c")).toBe(false)
  })

  test("unicode and space names work", () => {
    expect(FSUtil.contains("/日本/my dir", "/日本/my dir/ファイル.txt")).toBe(true)
    expect(FSUtil.contains("/日本/my dir", "/日本/my dir2")).toBe(false)
  })

  test("a null byte or a very long path does not throw", () => {
    expect(() => FSUtil.contains("/a/b", "/a/b/\0/../../x")).not.toThrow()
    expect(FSUtil.contains("/a/b", "/a/b/" + "x/".repeat(50_000))).toBe(true)
    expect(FSUtil.contains("/a/b", "/a/b/" + "../".repeat(50_000))).toBe(false)
  })

  test("overlaps is symmetric and false for siblings", () => {
    expect(FSUtil.overlaps("/a/b", "/a/b/c")).toBe(FSUtil.overlaps("/a/b/c", "/a/b"))
    expect(FSUtil.overlaps("/a/b", "/a/b2")).toBe(false)
    expect(FSUtil.overlaps("/a/b", "/a/b/../c")).toBe(false)
  })
})

describe("containsPath (project boundary)", () => {
  test("inside the directory or the worktree counts as inside", () => {
    const c = ctx("/repo/packages/app", "/repo")
    expect(containsPath("/repo/packages/app/src/x.ts", c)).toBe(true)
    expect(containsPath("/repo/README.md", c)).toBe(true)
    expect(containsPath("/repo/packages/app", c)).toBe(true)
  })

  test("outside both is outside, including lookalike siblings and traversal", () => {
    const c = ctx("/repo/packages/app", "/repo")
    expect(containsPath("/repo2/x", c)).toBe(false)
    expect(containsPath("/repo/../etc/passwd", c)).toBe(false)
    expect(containsPath("/repo/packages/app/../../../etc/passwd", c)).toBe(false)
    expect(containsPath("/etc/passwd", c)).toBe(false)
    expect(containsPath("/home/u/.ssh/id_rsa", c)).toBe(false)
  })

  test("a non-git project (worktree '/') must not make every absolute path inside", () => {
    const c = ctx("/home/u/proj", "/")
    expect(containsPath("/home/u/proj/a.txt", c)).toBe(true)
    expect(containsPath("/etc/passwd", c)).toBe(false)
    expect(containsPath("/home/u/other", c)).toBe(false)
    expect(containsPath("/", c)).toBe(false)
  })
})
