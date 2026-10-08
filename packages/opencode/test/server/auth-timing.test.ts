import { describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { Option, Redacted } from "effect"
import { ServerAuth as AppAuth } from "../../src/server/auth"
import { ServerAuth as CoreAuth } from "@yukioshi/server/auth"

const config = { username: "alice", password: Option.some("correct horse battery staple") }
const cred = (username: string, password: string) => ({ username, password: Redacted.make(password) })

describe.each([
  ["app", AppAuth],
  ["server package", CoreAuth],
])("%s ServerAuth.authorized", (_name, auth) => {
  test("accepts only the exact credentials", () => {
    expect(auth.authorized(cred("alice", "correct horse battery staple"), config)).toBe(true)
    for (const [u, p] of [
      ["alice", ""],
      ["alice", "correct horse battery stapl"],
      ["alice", "correct horse battery staplee"],
      ["alice", "Correct horse battery staple"],
      ["", "correct horse battery staple"],
      ["Alice", "correct horse battery staple"],
      ["alice\0", "correct horse battery staple"],
    ])
      expect(auth.authorized(cred(u, p), config)).toBe(false)
    expect(auth.authorized(cred("alice", "x"), { username: "alice", password: Option.none() })).toBe(false)
  })

  test("compares with timingSafeEqual on fixed-length digests, for username and password", () => {
    const spy = spyOn(crypto, "timingSafeEqual")
    try {
      auth.authorized(cred("zzzz-completely-different-length-username", "p"), config)
      // both comparisons run even though the username is already wrong
      expect(spy).toHaveBeenCalledTimes(2)
      for (const call of spy.mock.calls) {
        expect((call[0] as Buffer).length).toBe(32)
        expect((call[1] as Buffer).length).toBe(32)
      }
    } finally {
      spy.mockRestore()
    }
  })
})
