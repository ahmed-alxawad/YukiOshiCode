import { expect, test } from "bun:test"
import { logo } from "../../src/logo"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(logo.left).toHaveLength(4)
  expect(logo.right).toHaveLength(4)
  expect(logo.left.join(" ")).toContain("✦")
  expect(logo.left.join(" ")).toContain("◆")
  expect(logo.right.join(" ")).toContain("< / CODE >")
  expect(logo.right.join(" ")).toContain("█")
  expect(epilogue).toContain("yukioshi -s ses_123")
})
