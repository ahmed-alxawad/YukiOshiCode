import { describe, expect, test } from "bun:test"
import { formatMessage, formatTranscript } from "../../src/util/transcript"
import type { Part, UserMessage } from "@yukioshi/sdk/v2"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

const options = { thinking: true, toolDetails: true, assistantMetadata: false }

const user = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "p", modelID: "m" },
} as unknown as UserMessage

const parts: Part[] = [
  { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: `use key ${openai} please` },
  {
    id: "prt_2",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "c1",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: `curl --token ${github} https://example.com` },
      output: `export GITHUB_TOKEN=${github}`,
      title: "run",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as Part,
]

describe("session transcript", () => {
  test("a markdown transcript holds no secret", () => {
    const text = formatTranscript(
      { id: "ses_1", title: `notes ${github}`, time: { created: 1, updated: 2 } },
      [{ info: user, parts }],
      options,
    )
    expect(text).not.toContain(openai)
    expect(text).not.toContain(github)
    expect(text).toContain("[REDACTED:")
    expect(text).toContain("## User")
  })

  test("a single formatted message holds no secret", () => {
    const text = formatMessage(user, parts, options)
    expect(text).not.toContain(openai)
    expect(text).not.toContain(github)
  })
})
