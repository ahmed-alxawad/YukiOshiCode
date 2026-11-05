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

  test("child processes get an explicit env without the launch token, even while it is in process.env", async () => {
    const saved = { ...process.env }
    process.env.KOTHORA_DESKTOP_TOKEN = token
    process.env.YUKIOSHI_SERVER_PASSWORD = token
    try {
      const { Process } = await import("../../src/util/process")
      const read = async (opts: Parameters<typeof Process.run>[1]) =>
        (
          await Process.run(
            [process.execPath, "-e", "console.log(JSON.stringify([process.env.KOTHORA_DESKTOP_TOKEN, process.env.YUKIOSHI_SERVER_PASSWORD, process.env.KEEP_ME]))"],
            { ...opts, nothrow: true },
          )
        ).stdout.toString()
      for (const opts of [{}, { env: { KEEP_ME: "1" } }, { env: { KOTHORA_DESKTOP_TOKEN: token } }]) {
        expect(await read(opts)).not.toContain(token)
      }
      expect(await read({ env: { KEEP_ME: "1" } })).toContain('"1"')
      const { childEnv } = await import("@yukioshi/core/util/child-env")
      const env = childEnv({ KEEP_ME: "1" })
      expect(env.KEEP_ME).toBe("1")
      expect(env.PATH).toBe(process.env.PATH ?? "")
      expect(JSON.stringify(env)).not.toContain(token)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})
