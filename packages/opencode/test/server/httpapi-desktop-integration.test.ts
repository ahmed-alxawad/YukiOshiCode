import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir, realpath, rm, symlink } from "node:fs/promises"
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

  test("rejects symlink escapes, subdirectories, missing dirs, workspace params, session dirs, pty cwd and /pty", async () => {
    await using workspace = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using outside = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const link = `${workspace.path}-escape-link`
    const alias = `${workspace.path}-alias-link`
    await symlink(outside.path, link, "dir")
    await symlink(workspace.path, alias, "dir")
    await mkdir(`${workspace.path}/sub`)
    await symlink(outside.path, `${workspace.path}/sub-link`, "dir")

    const auth = { username: "kothora-desktop", password: "desktop-integration-secret" }
    Flag.YUKIOSHI_SERVER_USERNAME = auth.username
    Flag.YUKIOSHI_SERVER_PASSWORD = auth.password
    process.env.YUKIOSHI_SERVER_USERNAME = auth.username
    process.env.YUKIOSHI_SERVER_PASSWORD = auth.password
    const authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: false, randomPort: true })
    const call = (pathname: string, init: RequestInit & { dir?: string; query?: Record<string, string> } = {}) => {
      const url = new URL(pathname, listener.url)
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
      const headers: Record<string, string> = { authorization, ...(init.headers as Record<string, string>) }
      if (init.dir) headers["x-yukioshi-directory"] = init.dir
      return fetch(url, { ...init, headers })
    }
    try {
      // A session whose stored directory is outside, made before confinement is switched on.
      delete process.env.KOTHORA_DESKTOP_WORKSPACE
      const created = await call("/session", {
        method: "POST",
        dir: outside.path,
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(created.status).toBe(200)
      const outsideSession = ((await created.json()) as { id: string }).id

      process.env.KOTHORA_DESKTOP_WORKSPACE = workspace.path

      // symlink inside/next to the workspace that points out, via header and query
      expect((await call("/file/status", { dir: link })).status).toBe(403)
      expect((await call("/file/status", { query: { directory: link } })).status).toBe(403)
      expect((await call("/file/status", { dir: `${workspace.path}/sub-link` })).status).toBe(403)
      // a symlink to the workspace itself canonicalizes and is allowed
      const viaAlias = await call("/path", { dir: alias })
      expect(viaAlias.status).toBe(200)
      expect(await viaAlias.json()).toEqual(expect.objectContaining({ directory: await realpath(workspace.path) }))
      // subdirectory and missing directory are refused (equality is strict by design)
      expect((await call("/file/status", { dir: `${workspace.path}/sub` })).status).toBe(403)
      expect((await call("/file/status", { dir: `${workspace.path}/missing` })).status).toBe(403)
      // ?workspace= parameters never reach an outside directory
      for (const id of ["wrk_doesnotexist", "wrk_remote"]) {
        const res = await call("/file/status", { query: { workspace: id }, dir: outside.path })
        expect(res.status).toBe(403)
      }
      // session whose stored directory is outside
      expect((await call(`/session/${outsideSession}`)).status).not.toBe(200)
      expect((await call(`/session/${outsideSession}`, { dir: workspace.path })).status).not.toBe(200)

      // pty: header directory, body-level cwd, and the websocket route
      expect((await call("/pty", { dir: outside.path })).status).toBe(403)
      const ptyBody = (cwd?: string) => ({
        method: "POST",
        dir: workspace.path,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/bin/sh", cwd }),
      })
      expect((await call("/pty", ptyBody(outside.path))).status).toBe(403)
      expect((await call("/pty", ptyBody(link))).status).toBe(403)
      expect((await call("/pty", ptyBody(`${workspace.path}/sub`))).status).toBe(403)
      const ok = await call("/pty", ptyBody(workspace.path))
      expect(ok.status).toBe(200)
      const ptyID = ((await ok.json()) as { id: string }).id
      expect((await call(`/pty/${ptyID}/connect`, { dir: outside.path, headers: { upgrade: "websocket" } })).status).toBe(403)
      expect((await call(`/pty/${ptyID}/connect-token`, { method: "POST", dir: outside.path })).status).toBe(403)
      await call(`/pty/${ptyID}`, { method: "DELETE", dir: workspace.path })
    } finally {
      await rm(link, { force: true })
      await rm(alias, { force: true })
      await listener.stop(true)
      await disposeAllInstances()
    }
  }, 60_000)
})
