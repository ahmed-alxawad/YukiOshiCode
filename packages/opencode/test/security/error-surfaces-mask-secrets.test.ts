import { describe, expect, test } from "bun:test"
import { Cause } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderV2 } from "@yukioshi/core/provider"
import { failureEvent } from "../../src/server/routes/instance/httpapi/handlers/session-errors"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"
const providerID = ProviderV2.ID.make("openai")

describe("error text that is stored, exported and streamed", () => {
  test("a provider error that echoes an unregistered key is masked", () => {
    const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${openai}` } })
    const result = MessageV2.fromError(Object.assign(new Error(`bad key ${openai}`), { responseBody: body }), {
      providerID,
    })
    const json = JSON.stringify(result)
    expect(json).not.toContain(openai)
    expect(json).toContain("[REDACTED:")
  })

  test("a provider error with a key in a url and a token flag is masked", () => {
    const result = MessageV2.fromError(new Error(`GET https://u:${github}@host/x failed; retry with --token ${github}`), {
      providerID,
    })
    expect(JSON.stringify(result)).not.toContain(github)
  })

  test("the async prompt failure event is masked", () => {
    const event = failureEvent(Cause.die(new Error(`provider said: key ${openai}, token=${github}`)))
    const json = JSON.stringify(event)
    expect(json).not.toContain(openai)
    expect(json).not.toContain(github)
    expect(json).toContain("provider said")
  })
})
