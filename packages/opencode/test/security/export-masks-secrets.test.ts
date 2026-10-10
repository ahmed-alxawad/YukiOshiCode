import { describe, expect, test } from "bun:test"
import { exportOutput } from "../../src/cli/cmd/export"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

function data() {
  return {
    info: { id: "ses_1", title: `deploy with ${github}`, directory: "/tmp/x" },
    messages: [
      {
        info: { id: "msg_1", role: "user" },
        parts: [
          { id: "prt_1", type: "text", text: `my key is ${openai}` },
          {
            id: "prt_2",
            type: "tool",
            state: {
              status: "completed",
              input: { command: `curl -H "Authorization: Bearer ${github}"`, env: `API_KEY=${openai}` },
              output: "ok",
              title: "t",
              metadata: {},
            },
          },
        ],
      },
    ],
  } as any
}

describe("session export", () => {
  test("masks secrets in prompts, titles and tool input by default", () => {
    const json = JSON.stringify(exportOutput(data()))
    expect(json).not.toContain(openai)
    expect(json).not.toContain(github)
    expect(json).toContain("[REDACTED:")
    expect(json).toContain("ses_1")
  })

  test("does not modify the stored session", () => {
    const input = data()
    exportOutput(input)
    expect(input.messages[0].parts[0].text).toContain(openai)
  })

  test("sanitized export holds no secret either", () => {
    const json = JSON.stringify(exportOutput(data(), true))
    expect(json).not.toContain(openai)
    expect(json).not.toContain(github)
  })
})
