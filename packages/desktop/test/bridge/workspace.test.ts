import { describe, expect, test } from "bun:test"
import { WorkspaceService, type FileEntry, type WorkspaceFileSystem } from "../../src/main/workspace"

const entry = (name: string, kind: "file" | "directory"): FileEntry => ({
  name,
  isFile: () => kind === "file",
  isDirectory: () => kind === "directory",
})

describe("WorkspaceService", () => {
  test("lists and reads only canonical paths inside the selected workspace", async () => {
    const fs: WorkspaceFileSystem = {
      realpath: async (value) => value,
      readdir: async () => [entry("src", "directory"), entry("README.md", "file")],
      readFile: async (value) => `read:${value}`,
    }
    const service = new WorkspaceService(fs, { pickDirectory: async () => "/work/project" })
    await service.select()

    expect(await service.listFiles()).toEqual([
      { path: "README.md", kind: "file" },
      { path: "src", kind: "directory" },
    ])
    expect(await service.readFile("src/index.ts")).toBe("read:/work/project/src/index.ts")
  })

  test("rejects lexical traversal, absolute paths, and symlink escapes", async () => {
    const fs: WorkspaceFileSystem = {
      realpath: async (value) => (value.endsWith("link") ? "/outside/secret" : value),
      readdir: async () => [],
      readFile: async () => "secret",
    }
    const service = new WorkspaceService(fs, { pickDirectory: async () => "/work/project" })
    await service.select()

    await expect(service.readFile("../secret")).rejects.toThrow("escapes")
    await expect(service.readFile("/etc/passwd")).rejects.toThrow("Absolute")
    await expect(service.readFile("link")).rejects.toThrow("escapes")
  })
})
