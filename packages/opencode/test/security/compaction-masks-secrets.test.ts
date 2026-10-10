import { describe, expect, test } from "bun:test"
import { serializeConversation } from "../../src/session/compaction"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

const messages = [
  {
    info: { id: "msg_1", role: "user" },
    parts: [{ id: "prt_1", type: "text", text: `deploy using ${openai}` }],
  },
  {
    info: { id: "msg_2", role: "assistant" },
    parts: [
      { id: "prt_2", type: "text", text: `I will export GITHUB_TOKEN=${github}` },
      {
        id: "prt_3",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: `git clone https://me:${github}@example.com/r.git` },
          output: `password=${"hunter2hunter2"}`,
          title: "t",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
      { id: "prt_4", type: "tool", tool: "bash", state: { status: "error", input: {}, error: `failed with ${openai}` } },
    ],
  },
] as any

describe("/compact conversation sent to the model", () => {
  test("holds no secret from prompts, tool input, tool output or errors", () => {
    const text = serializeConversation(messages)
    expect(text).not.toContain(openai)
    expect(text).not.toContain(github)
    expect(text).not.toContain("hunter2hunter2")
    expect(text).toContain("[User]: deploy using")
    expect(text).toContain("[REDACTED:")
  })

  test("honours redact.enabled=false", () => {
    expect(serializeConversation(messages, { enabled: false })).toContain(openai)
  })
})
