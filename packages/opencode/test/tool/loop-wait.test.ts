import { describe, expect, test } from "bun:test"
import { wait } from "../../src/tool/loop-wait"
import { SessionRepeat } from "../../src/session/repeat"

describe("loop_wait", () => {
  test("is refused outside a loop run, clamps inside one", () => {
    expect(wait("lw1", { seconds: 300 }).title).toBe("loop_wait refused")
    SessionRepeat.beginPaced("lw1", 60)
    expect(wait("lw1", { seconds: 10 }).output).toContain("60 seconds")
    expect(wait("lw1", { seconds: 1e9 }).output).toContain("3600 seconds")
    expect(SessionRepeat.endPaced("lw1")).toMatchObject({ seconds: 3600 })
  })
})
