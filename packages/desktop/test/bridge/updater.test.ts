import { describe, expect, test } from "bun:test"
import { createUpdateController, type DesktopUpdater } from "../../src/main/updater"

const fakeUpdater = () => {
  const calls: string[] = []
  const updater: DesktopUpdater = {
    setFeedURL: (url) => void calls.push(`feed:${url}`),
    checkForUpdates: async () => void calls.push("check"),
  }
  return { calls, updater }
}

describe("desktop auto updater", () => {
  test("stays disabled without touching the updater", async () => {
    const { calls, updater } = fakeUpdater()
    await createUpdateController(false, updater).check()
    expect(calls).toEqual([])
  })

  test("sets an explicit public HTTPS feed before checking", async () => {
    const { calls, updater } = fakeUpdater()
    await createUpdateController(true, updater, "https://updates.kothora.app/releases").check()
    expect(calls).toEqual(["feed:https://updates.kothora.app/releases", "check"])
  })

  test("requires a configured feed when enabled", () => {
    const { updater } = fakeUpdater()
    expect(() => createUpdateController(true, updater, undefined)).toThrow("explicitly configured public HTTPS")
    expect(() => createUpdateController(true, updater, "")).toThrow("explicitly configured public HTTPS")
  })

  test("rejects credentials, local and private hosts, and path tricks", () => {
    const unsafe = [
      "http://updates.example.com/releases",
      "https://token@updates.example.com/releases",
      "https://updates.example.com/releases?token=secret",
      "https://updates.example.com/releases#secret",
      "https://localhost/releases",
      "https://localhost./releases",
      "https://updates.local./releases",
      "https://updates.internal/releases",
      "https://updates.internal./releases",
      "https://127.0.0.1/releases",
      "https://10.0.0.1/releases",
      "https://100.64.0.1/releases",
      "https://192.0.2.1/releases",
      "https://198.51.100.1/releases",
      "https://203.0.113.1/releases",
      "https://[::1]/releases",
      "https://[2001:db8::1]/releases",
      "https://updates.example.com/releases%2f..%2fprivate",
      "https://updates.example.com\\@127.0.0.1/releases",
    ]
    const { updater } = fakeUpdater()
    for (const url of unsafe) expect(() => createUpdateController(true, updater, url)).toThrow("public HTTPS")
  })
})
