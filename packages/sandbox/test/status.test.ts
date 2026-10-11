import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { WINDOWS_REASON, confineWith, select, status } from "../src/backend"
import type { Profile } from "../src/profile"

const profile: Profile = {
  filesystem: { allowWrite: [{ path: "/workspace", kind: "subtree" }], denyWrite: [], denyNames: [] },
  network: { mode: "allow", allowedHosts: [] },
  environment: { deny: [], set: {} },
}

describe("sandbox status per platform", () => {
  test("windows says commands run without an OS sandbox and names the alternatives", () => {
    const result = status("win32")
    expect(result.available).toBe(false)
    expect(result.summary).toContain("not available on Windows: shell commands run without OS sandbox")
    expect(result.summary).toContain("use permission rules/review mode")
  })

  test("an unknown platform is reported unavailable", () => {
    const result = status("freebsd")
    expect(result.available).toBe(false)
    expect(result.summary).toContain("No sandbox backend")
  })

  test("a linux without bubblewrap names the install command", () => {
    const missing = { support: () => ({ available: false, reason: "No usable Bubblewrap executable is available" }), prepare: () => { throw new Error("unused") } }
    const result = status("linux", missing as never)
    expect(result.available).toBe(false)
    expect(result.summary).toContain("bubblewrap missing or unusable")
    expect(result.summary).toContain("apt install bubblewrap")
  })

  test("a working linux backend is reported available", () => {
    const ok = { support: () => ({ available: true }), prepare: () => { throw new Error("unused") } }
    expect(status("linux", ok as never)).toMatchObject({ available: true })
    expect(status("darwin", ok as never)).toMatchObject({ available: true })
  })
})

describe("sandbox.enabled on Windows fails closed", () => {
  test("the refusal names the reason and both alternatives", async () => {
    const result = await Effect.runPromise(
      Effect.result(Effect.scoped(confineWith(select("win32"), profile, { command: "echo", args: ["hi"] }))),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    const message = result.failure.message
    expect(message).toContain(WINDOWS_REASON)
    expect(message).toContain("not available on Windows")
    expect(message).toContain("sandbox.enabled is true")
    expect(message).toContain("permission rules and review mode")
  })
})
