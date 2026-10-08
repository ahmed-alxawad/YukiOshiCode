import { describe, expect, test } from "bun:test"
import path from "path"
import { Path as GlobalPath } from "@yukioshi/core/global"
import { sandboxProfile } from "../../src/tool/sandbox-profile"

const worktree = path.resolve("/work/repo")
const directory = path.resolve("/work/repo/pkg")
const instance = { directory, worktree } as Parameters<typeof sandboxProfile>[0]
const writable = (writablePaths: string[]) =>
  sandboxProfile(instance, { enabled: true, writablePaths }).filesystem.allowWrite.map((rule) => rule.path)

describe("sandboxProfile writablePaths", () => {
  test("expands a leading ~ to the home directory", () => {
    expect(writable(["~/.cache/my-tool"])).toContain(path.join(GlobalPath.home, ".cache/my-tool"))
    expect(writable(["~"])).toContain(GlobalPath.home)
  })

  test("resolves relative entries against the project root, not the process directory", () => {
    expect(writable(["build/out"])).toContain(path.resolve(worktree, "build/out"))
  })

  test("keeps absolute entries unchanged", () => {
    const abs = path.resolve("/opt/cache")
    expect(writable([abs])).toContain(abs)
  })
})

describe("sandboxProfile protected YukiOshi folders", () => {
  const denied = (writablePaths: string[] = [], inst = instance) =>
    sandboxProfile(inst, { enabled: true, writablePaths }).filesystem.denyWrite.map((rule) => rule.path)

  test("config, state and installed programs are read-only", () => {
    expect(denied()).toEqual(expect.arrayContaining([GlobalPath.config, GlobalPath.state, GlobalPath.bin]))
    expect(denied()).toContain(path.join(GlobalPath.data, "auth.json"))
    expect(denied()).not.toContain(GlobalPath.log)
  })

  test("an explicit writablePaths entry opts a folder back in", () => {
    expect(denied([GlobalPath.config])).not.toContain(GlobalPath.config)
  })

  test("a project that lives in a protected folder stays writable", () => {
    const inst = { directory: path.join(GlobalPath.state, "p"), worktree: "/" } as typeof instance
    expect(denied([], inst)).not.toContain(GlobalPath.state)
  })
})
