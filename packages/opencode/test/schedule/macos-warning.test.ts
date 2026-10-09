import { describe, expect, it } from "bun:test"
import { schedulerWarning } from "../../src/schedule/system"

describe("scheduler warning", () => {
  it("on macOS explains the cron limits", () => {
    const text = schedulerWarning("darwin")!
    expect(text).toContain("Full Disk Access")
    expect(text).toContain("~/Documents")
    expect(text).toContain("~/Desktop")
    expect(text).toContain("~/Downloads")
    expect(text).toContain("asleep")
    expect(text).toContain("Keychain")
  })

  it("is silent elsewhere", () => {
    expect(schedulerWarning("linux")).toBeUndefined()
    expect(schedulerWarning("win32")).toBeUndefined()
  })
})
