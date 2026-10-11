import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@yukioshi/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  YUKIOSHI_SERVER_PASSWORD: Flag.YUKIOSHI_SERVER_PASSWORD,
  YUKIOSHI_SERVER_USERNAME: Flag.YUKIOSHI_SERVER_USERNAME,
}

afterEach(() => {
  Flag.YUKIOSHI_SERVER_PASSWORD = original.YUKIOSHI_SERVER_PASSWORD
  Flag.YUKIOSHI_SERVER_USERNAME = original.YUKIOSHI_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.YUKIOSHI_SERVER_PASSWORD = undefined
    Flag.YUKIOSHI_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the yukioshi username", () => {
    Flag.YUKIOSHI_SERVER_PASSWORD = "secret"
    Flag.YUKIOSHI_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("yukioshi:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.YUKIOSHI_SERVER_PASSWORD = "secret"
    Flag.YUKIOSHI_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.YUKIOSHI_SERVER_PASSWORD = "secret"
    Flag.YUKIOSHI_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
    expect(ServerAuth.authorized({ username: "yukioshi", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("accepts both yukioshi and legacy opencode when default username is used", () => {
    const config = { password: Option.some("secret"), username: "yukioshi" }

    expect(ServerAuth.required(config)).toBe(true)
    // Both accepted with correct password
    expect(ServerAuth.authorized({ username: "yukioshi", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(true)
    // Wrong username refused
    expect(ServerAuth.authorized({ username: "mallory", password: Redacted.make("secret") }, config)).toBe(false)
    // Wrong password refused
    expect(ServerAuth.authorized({ username: "yukioshi", password: Redacted.make("wrong") }, config)).toBe(false)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("wrong") }, config)).toBe(false)
  })
})
