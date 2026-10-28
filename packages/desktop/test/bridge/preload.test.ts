import { describe, expect, test } from "bun:test"
import { desktopChannels } from "../../src/main/contracts"
import { createDesktopBridge } from "../../src/preload/bridge"

describe("preload bridge", () => {
  test("exposes only the narrow invoke facade", async () => {
    const calls: unknown[][] = []
    const bridge = createDesktopBridge({
      invoke: async (...args) => {
        calls.push(args)
        return undefined
      },
    })

    expect(Object.keys(bridge).sort()).toEqual([
      "cancelTask",
      "listChanges",
      "listWorkspaceFiles",
      "readDiff",
      "readWorkspaceFile",
      "selectWorkspace",
      "startTask",
    ])
    expect(Object.isFrozen(bridge)).toBe(true)
    await bridge.readWorkspaceFile("src/index.ts")
    expect(calls).toEqual([[desktopChannels.readWorkspaceFile, { path: "src/index.ts" }]])
  })
})
