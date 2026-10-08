import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import { Flag } from "@yukioshi/core/flag/flag"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const original = {
  flag: Flag.YUKIOSHI_SERVER_PASSWORD,
  env: process.env.YUKIOSHI_SERVER_PASSWORD,
}

afterEach(async () => {
  Flag.YUKIOSHI_SERVER_PASSWORD = original.flag
  if (original.env === undefined) delete process.env.YUKIOSHI_SERVER_PASSWORD
  else process.env.YUKIOSHI_SERVER_PASSWORD = original.env
  await disposeAllInstances()
  await resetDatabase()
})

function setPassword(password: string | undefined) {
  Flag.YUKIOSHI_SERVER_PASSWORD = password
  if (password === undefined) delete process.env.YUKIOSHI_SERVER_PASSWORD
  else process.env.YUKIOSHI_SERVER_PASSWORD = password
}

// fetch() forbids overriding Host, which is exactly what a rebinding page gets for free.
function get(listener: { port: number }, host: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: listener.port, path: "/global/health", method, headers: { host, ...headers } },
      (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("DNS rebinding host guard", () => {
  test("unauthenticated loopback server rejects foreign Host values", async () => {
    setPassword(undefined)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      for (const host of [
        "evil.example",
        `evil.example:${listener.port}`,
        "localhost.evil.example",
        "127.0.0.1.evil.example",
        "evil.example.",
        "[::1",
        "a b",
      ]) {
        const res = await get(listener, host)
        expect({ host, status: res.status }).toEqual({ host, status: 403 })
        expect(res.body).not.toContain("healthy")
      }
      // a rebinding page is same-origin with its own Host, so a mutating request carries Origin == Host
      const post = await get(listener, "evil.example", { origin: "http://evil.example" }, "POST")
      expect(post.status).toBe(403)
    } finally {
      await listener.stop(true)
    }
  })

  test("unauthenticated loopback server still serves loopback names", async () => {
    setPassword(undefined)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      for (const host of [
        `127.0.0.1:${listener.port}`,
        `localhost:${listener.port}`,
        "localhost",
        `app.localhost:${listener.port}`,
        `[::1]:${listener.port}`,
        "10.1.2.3:4096",
      ]) {
        const res = await get(listener, host)
        expect({ host, status: res.status }).toEqual({ host, status: 200 })
      }
    } finally {
      await listener.stop(true)
    }
  })

  test("explicitly configured origins may be used as the Host", async () => {
    setPassword(undefined)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://yuki.proxy.test"] })
    try {
      expect((await get(listener, "yuki.proxy.test")).status).toBe(200)
      expect((await get(listener, "other.proxy.test")).status).toBe(403)
    } finally {
      await listener.stop(true)
    }
  })

  test("password-protected servers keep accepting any Host (credentials are the boundary)", async () => {
    setPassword("host-guard-secret")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const auth = { authorization: `Basic ${btoa("opencode:host-guard-secret")}` }
      expect((await get(listener, "proxy.example", auth)).status).toBe(200)
      expect((await get(listener, "evil.example")).status).toBe(401)
    } finally {
      await listener.stop(true)
    }
  })

  test("servers bound to a non-loopback address are not Host-restricted", async () => {
    setPassword(undefined)
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0 })
    try {
      expect((await get(listener, "box.example.com")).status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  })
})
