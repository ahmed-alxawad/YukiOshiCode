import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@yukioshi/core/flag/flag"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const original = { flag: Flag.YUKIOSHI_SERVER_PASSWORD, env: process.env.YUKIOSHI_SERVER_PASSWORD }

afterEach(async () => {
  Flag.YUKIOSHI_SERVER_PASSWORD = original.flag
  if (original.env === undefined) delete process.env.YUKIOSHI_SERVER_PASSWORD
  else process.env.YUKIOSHI_SERVER_PASSWORD = original.env
  await disposeAllInstances()
  await resetDatabase()
})

describe("CSRF origin guard", () => {
  test("mutating requests from foreign origins are refused, even without a body", async () => {
    Flag.YUKIOSHI_SERVER_PASSWORD = undefined
    delete process.env.YUKIOSHI_SERVER_PASSWORD
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const post = (origin?: string) =>
        fetch(new URL("/sync/start", listener.url), { method: "POST", headers: origin ? { origin } : {} })
      for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "https://yukioshi.com.evil.example"])
        expect({ origin, status: (await post(origin)).status }).toEqual({ origin, status: 403 })
      // allowed origins and origin-less clients keep working
      expect((await post()).status).toBe(200)
      expect((await post("http://localhost:3000")).status).toBe(200)
      expect((await post("https://app.yukioshi.com")).status).toBe(200)
      // reads are not affected
      const read = await fetch(new URL("/global/health", listener.url), { headers: { origin: "https://evil.example" } })
      expect(read.status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  })
})
