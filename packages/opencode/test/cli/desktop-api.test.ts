import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearDesktopSecretEnv, resolveDesktopApiConfig } from "../../src/cli/cmd/desktop-api"

const roots: string[] = []
const token = "A".repeat(43)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop API bootstrap", () => {
  test("requires a strong base64url launch token and canonical directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kothora-desktop-api-"))
    roots.push(root)
    const workspace = path.join(root, "workspace")
    await mkdir(workspace)
    await expect(resolveDesktopApiConfig(workspace, token)).resolves.toEqual({
      workspace: await realpath(workspace),
      token,
    })
    await expect(resolveDesktopApiConfig(workspace, "short")).rejects.toThrow("base64url")
    await expect(resolveDesktopApiConfig(workspace, `${"A".repeat(42)}!`)).rejects.toThrow("base64url")
  })

  test("canonicalizes a selected symlink and rejects files or missing paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kothora-desktop-api-"))
    roots.push(root)
    const workspace = path.join(root, "workspace")
    const alias = path.join(root, "workspace-link")
    const file = path.join(root, "file.txt")
    await mkdir(workspace)
    await symlink(workspace, alias, "dir")
    await writeFile(file, "not a workspace")

    expect((await resolveDesktopApiConfig(alias, token)).workspace).toBe(await realpath(workspace))
    await expect(resolveDesktopApiConfig(file, token)).rejects.toThrow("directory")
    await expect(resolveDesktopApiConfig(path.join(root, "missing"), token)).rejects.toThrow()
  })

  test("clearDesktopSecretEnv removes launch secrets so child tools do not inherit them", () => {
    const env: NodeJS.ProcessEnv = {
      KOTHORA_DESKTOP_TOKEN: token,
      YUKIOSHI_SERVER_PASSWORD: token,
      YUKIOSHI_SERVER_USERNAME: "kothora-desktop",
      KOTHORA_DESKTOP_WORKSPACE: "/tmp/workspace",
    }
    clearDesktopSecretEnv(env)
    expect(env.KOTHORA_DESKTOP_TOKEN).toBeUndefined()
    expect(env.YUKIOSHI_SERVER_PASSWORD).toBeUndefined()
    expect(env.YUKIOSHI_SERVER_USERNAME).toBeUndefined()
    expect(env.KOTHORA_DESKTOP_WORKSPACE).toBe("/tmp/workspace")
  })
})
