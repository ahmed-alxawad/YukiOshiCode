import { describe, expect, test } from "bun:test"
import { buildCrashMetadata, createCrashSender } from "../../src/main/crash-reporter"

describe("desktop crash reporting", () => {
  test("never includes exception messages, code, prompts, paths, or stacks", () => {
    const secret = "/home/alice/private.ts prompt: delete production"
    const error = new Error(secret)
    error.name = "Type Error<script>"
    error.stack = `${secret}\nconst token = 'secret'`

    const metadata = buildCrashMetadata(error)
    const serialized = JSON.stringify(metadata)
    expect(metadata.errorName).toBe("TypeErrorscript")
    expect(serialized).not.toContain("alice")
    expect(serialized).not.toContain("prompt")
    expect(serialized).not.toContain("token")
    expect(Object.keys(metadata).sort()).toEqual(["appVersion", "arch", "errorName", "platform"])
  })

  test("posts anonymous metadata only to configured HTTPS without redirects", async () => {
    const calls: unknown[][] = []
    const sender = createCrashSender("https://crashes.example.test/v1/report", async (...args) => {
      calls.push(args)
      return { ok: true }
    })
    await sender(buildCrashMetadata(new Error("private")))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe("https://crashes.example.test/v1/report")
    expect(calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" })
    expect(String((calls[0]?.[1] as { body: string }).body)).not.toContain("private")
  })

  test("rejects unsafe collector configuration", () => {
    const fetcher = async () => ({ ok: true })
    expect(() => createCrashSender("http://crashes.example.test", fetcher)).toThrow()
    expect(() => createCrashSender("https://token@crashes.example.test", fetcher)).toThrow()
    expect(() => createCrashSender("https://localhost/report", fetcher)).toThrow()
  })
})
