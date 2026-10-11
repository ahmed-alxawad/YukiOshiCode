import { describe, expect, test as test_ } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { sandboxEffect } from "@/cli/cmd/debug/sandbox"

describe("debug sandbox effect text", () => {
  cliIt.live("prints the platform status and the configured effect as json", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["debug", "sandbox", "--format", "json"])
      opencode.expectExit(result, 0)
      const data = JSON.parse(result.stdout)
      expect(data.platform).toBe(process.platform)
      expect(data.enabled).toBe(false)
      expect(typeof data.status).toBe("string")
      expect(data.effect).toContain("without an OS sandbox")
    }),
  )
})

describe("sandboxEffect", () => {
  test_("sandbox on and available confines", () => {
    expect(sandboxEffect(true, true, "linux")).toBe("shell commands run inside the OS sandbox")
  })
  test_("sandbox on but unavailable refuses", () => {
    expect(sandboxEffect(false, true, "win32")).toContain("refused")
  })
  test_("windows with the sandbox off names the remaining protections", () => {
    expect(sandboxEffect(false, false, "win32")).toContain("permission rules and review mode")
  })
})


