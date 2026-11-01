import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Flag } from "@yukioshi/core/flag/flag"
import { DesktopPaths } from "../../src/server/routes/instance/httpapi/groups/desktop"
import { clearDesktopSecretEnv } from "../../src/cli/cmd/desktop-api"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const original = {
  password: Flag.YUKIOSHI_SERVER_PASSWORD,
  username: Flag.YUKIOSHI_SERVER_USERNAME,
  envPassword: process.env.YUKIOSHI_SERVER_PASSWORD,
  envUsername: process.env.YUKIOSHI_SERVER_USERNAME,
  token: process.env.KOTHORA_DESKTOP_TOKEN,
  workspace: process.env.KOTHORA_DESKTOP_WORKSPACE,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  Flag.YUKIOSHI_SERVER_PASSWORD = original.password
  Flag.YUKIOSHI_SERVER_USERNAME = original.username
  restore("YUKIOSHI_SERVER_PASSWORD", original.envPassword)
  restore("YUKIOSHI_SERVER_USERNAME", original.envUsername)
  restore("KOTHORA_DESKTOP_TOKEN", original.token)
  restore("KOTHORA_DESKTOP_WORKSPACE", original.workspace)
  await disposeAllInstances()
  await resetDatabase()
})

describe("desktop HTTP API integration", () => {
  test("requires auth and confines changes to the configured desktop workspace", async () => {
    await using workspace = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using outside = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Bun.write(`${workspace.path}/desktop-change.txt`, "desktop\n")
    await $`git add desktop-change.txt`.cwd(workspace.path).quiet()

    const auth = { username: "kothora-desktop", password: "desktop-integration-secret" }
    Flag.YUKIOSHI_SERVER_USERNAME = auth.username
    Flag.YUKIOSHI_SERVER_PASSWORD = auth.password
    process.env.YUKIOSHI_SERVER_USERNAME = auth.username
    process.env.YUKIOSHI_SERVER_PASSWORD = auth.password
    process.env.KOTHORA_DESKTOP_TOKEN = auth.password
    process.env.KOTHORA_DESKTOP_WORKSPACE = workspace.path

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: false, randomPort: true })
    clearDesktopSecretEnv()
    expect(process.env.KOTHORA_DESKTOP_TOKEN).toBeUndefined()
    expect(process.env.YUKIOSHI_SERVER_PASSWORD).toBeUndefined()
    expect(process.env.YUKIOSHI_SERVER_USERNAME).toBeUndefined()
    try {
      const url = new URL(DesktopPaths.changes, listener.url)
      const unauthenticated = await fetch(url, {
        headers: { "x-yukioshi-directory": workspace.path },
      })
      expect(unauthenticated.status).toBe(401)

      const authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`
      const confined = await fetch(url, {
        headers: {
          authorization,
          "x-yukioshi-directory": outside.path,
        },
      })
      expect(confined.status).toBe(403)

      const authorized = await fetch(url, {
        headers: {
          authorization,
          "x-yukioshi-directory": workspace.path,
        },
      })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toContainEqual(
        expect.objectContaining({ path: "desktop-change.txt", status: "added" }),
      )

      await Bun.write(`${outside.path}/outside-secret.txt`, "outside-workspace-data\n")
      const fileHeaderEscape = new URL("/file/status", listener.url)
      const escapedViaHeader = await fetch(fileHeaderEscape, {
        headers: {
          authorization,
          "x-yukioshi-directory": outside.path,
        },
      })
      expect(escapedViaHeader.status).toBe(403)

      const fileQueryEscape = new URL("/file/status", listener.url)
      fileQueryEscape.searchParams.set("directory", outside.path)
      const escapedViaQuery = await fetch(fileQueryEscape, {
        headers: { authorization },
      })
      expect(escapedViaQuery.status).toBe(403)

      const pathHeaderEscape = new URL("/path", listener.url)
      const escapedPathViaHeader = await fetch(pathHeaderEscape, {
        headers: {
          authorization,
          "x-yukioshi-directory": outside.path,
        },
      })
      expect(escapedPathViaHeader.status).toBe(403)

      const defaultDirPath = new URL("/path", listener.url)
      const withinDefault = await fetch(defaultDirPath, {
        headers: { authorization },
      })
      expect(withinDefault.status).toBe(200)
      expect(await withinDefault.json()).toEqual(
        expect.objectContaining({ directory: workspace.path }),
      )
    } finally {
      await listener.stop(true)
      await disposeAllInstances()
    }
  }, 30_000)
})
