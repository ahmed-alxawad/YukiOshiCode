import { expect, test } from "bun:test"
import { createTuiAttention } from "../src/attention"
import { resolve } from "../src/config"

test("labels the compatibility sound-pack ID as YukiOshi", () => {
  const attention = createTuiAttention({
    renderer: {
      isDestroyed: false,
      on() {},
      off() {},
      triggerNotification() {
        return false
      },
    },
    config: resolve({}, { terminalSuspend: true }),
  })

  expect(attention.soundboard.list()).toContainEqual({
    id: "opencode.default",
    name: "YukiOshi Default",
    active: true,
    builtin: true,
  })
  attention.dispose()
})
