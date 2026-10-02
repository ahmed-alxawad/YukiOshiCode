import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("trust command", () => {
  cliIt.live(
    "persists, reports, and revokes explicit project trust",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const initial = yield* opencode.spawn(["trust", home, "--status"])
        opencode.expectExit(initial, 0, "trust --status")
        expect(initial.stderr).toContain(": untrusted")

        const trusted = yield* opencode.spawn(["trust", home])
        opencode.expectExit(trusted, 0, "trust")
        expect(trusted.stderr).toContain(`Trusted ${home}`)

        const afterTrust = yield* opencode.spawn(["trust", home, "--status"])
        opencode.expectExit(afterTrust, 0, "trust --status")
        expect(afterTrust.stderr).toContain(": trusted")

        const revoked = yield* opencode.spawn(["trust", home, "--revoke"])
        opencode.expectExit(revoked, 0, "trust --revoke")
        expect(revoked.stderr).toContain(`Revoked trust for ${home}`)

        const afterRevoke = yield* opencode.spawn(["trust", home, "--status"])
        opencode.expectExit(afterRevoke, 0, "trust --status")
        expect(afterRevoke.stderr).toContain(": untrusted")
      }),
    60_000,
  )
})
