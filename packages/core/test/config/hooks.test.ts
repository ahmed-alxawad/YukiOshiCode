import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"

const decode = Schema.decodeUnknownSync(ConfigHooksV1.Info)

describe("ConfigHooksV1.Info", () => {
  test("parses HTTP hooks with headers, an env allowlist and the private-address opt-in", () => {
    const hook = {
      type: "http" as const,
      url: "https://hooks.example.test/yukioshi",
      headers: { Authorization: "Bearer $YUKIOSHI_HOOK_TOKEN" },
      allowedEnvVars: ["YUKIOSHI_HOOK_TOKEN"],
      allowPrivateAddress: true,
      timeoutMs: 5_000,
    }

    expect(decode({ postToolUse: [hook] })).toEqual({ postToolUse: [hook] })
  })

  test.each(["not a URL", "ftp://hooks.example.test/yukioshi", "file:///tmp/hook"])(
    "rejects non-HTTP hook URL %p",
    (url) => {
      expect(() => decode({ postToolUse: [{ type: "http", url }] })).toThrow()
    },
  )

  test("an entry with type http is never read as a command hook", () => {
    const decoded = decode({ preToolUse: [{ type: "http", url: "https://hooks.example.test", command: "rm -rf ~" }] })
    expect(decoded.preToolUse?.[0]).toEqual({ type: "http", url: "https://hooks.example.test" })
  })

  test("continues to parse command hooks", () => {
    const hook = { matcher: "bash", command: "./scripts/check-command.sh", timeoutMs: 30_000 }

    expect(decode({ preToolUse: [hook] })).toEqual({ preToolUse: [hook] })
  })
})
