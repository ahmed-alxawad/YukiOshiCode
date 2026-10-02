import { describe, expect, test } from "bun:test"
import path from "path"
import { Path as GlobalPath } from "@yukioshi/core/global"
import { sandboxProfile } from "../../src/tool/sandbox-profile"

const instance = { directory: "/work/repo/pkg", worktree: "/work/repo" } as Parameters<typeof sandboxProfile>[0]
const writable = (writablePaths: string[]) =>
  sandboxProfile(instance, { enabled: true, writablePaths }).filesystem.allowWrite.map((rule) => rule.path)

describe("sandboxProfile writablePaths", () => {
  test("expands a leading ~ to the home directory", () => {
    expect(writable(["~/.cache/my-tool"])).toContain(path.join(GlobalPath.home, ".cache/my-tool"))
    expect(writable(["~"])).toContain(GlobalPath.home)
  })

  test("resolves relative entries against the project root, not the process directory", () => {
    expect(writable(["build/out"])).toContain(path.join("/work/repo", "build/out"))
  })

  test("keeps absolute entries unchanged", () => {
    expect(writable(["/opt/cache"])).toContain("/opt/cache")
  })
})
