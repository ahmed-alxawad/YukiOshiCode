import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SessionFallback } from "../../src/session/fallback"

const api = (data: Record<string, unknown>) => ({ name: "APIError", data })

describe("SessionFallback", () => {
  test("switches models for provider-side failures", () => {
    expect(SessionFallback.eligible({ name: "ProviderAuthError", data: {} })).toBe(true)
    expect(SessionFallback.eligible(api({ statusCode: 429 }))).toBe(true)
    expect(SessionFallback.eligible(api({ statusCode: 503 }))).toBe(true)
    expect(SessionFallback.eligible(api({ isRetryable: true }))).toBe(true)
    expect(SessionFallback.eligible(api({ message: "You exceeded your current quota" }))).toBe(true)
  })

  test("keeps the model for problems another model would not fix", () => {
    expect(SessionFallback.eligible(undefined)).toBe(false)
    expect(SessionFallback.eligible({ name: "MessageAbortedError", data: {} })).toBe(false)
    expect(SessionFallback.eligible({ name: "ContextOverflowError", data: {} })).toBe(false)
    expect(SessionFallback.eligible(api({ statusCode: 400, message: "invalid tool schema" }))).toBe(false)
  })

  test("lists untried fallback models in order", () => {
    const models = [" openai/gpt-5 ", "anthropic/claude-sonnet-5", "not-a-model", "google/gemini-3.1-pro"]
    expect(SessionFallback.candidates(models, new Set(["anthropic/claude-sonnet-5"]))).toEqual([
      "openai/gpt-5",
      "google/gemini-3.1-pro",
    ])
    expect(SessionFallback.candidates(undefined, new Set())).toEqual([])
  })

  test("a model that failed over rests, and runs start on the model that took over", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-rest-"))
    const now = 1_000_000
    expect(await SessionFallback.restingTarget("a/1", now, state)).toBeUndefined()

    await SessionFallback.rest("a/1", "b/2", 300, now, state)
    expect(await SessionFallback.restingTarget("a/1", now + 1000, state)).toBe("b/2")
    // b/2 then failed over too: follow the chain.
    await SessionFallback.rest("b/2", "c/3", 300, now, state)
    expect(await SessionFallback.restingTarget("a/1", now + 1000, state)).toBe("c/3")
    // After the cooldown the chosen model is tried again.
    expect(await SessionFallback.restingTarget("a/1", now + 301_000, state)).toBeUndefined()
  })

  test("a cooldown of 0 never rests a model, and a loop of rests ends", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-rest-"))
    await SessionFallback.rest("a/1", "b/2", 0, 0, state)
    expect(await SessionFallback.restingTarget("a/1", 1, state)).toBeUndefined()
    await SessionFallback.rest("a/1", "b/2", 300, 0, state)
    await SessionFallback.rest("b/2", "a/1", 300, 0, state)
    expect(await SessionFallback.restingTarget("a/1", 1, state)).toBe("b/2")
  })
})
