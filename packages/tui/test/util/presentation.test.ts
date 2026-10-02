import { expect, test } from "bun:test"
import { logo } from "../../src/logo"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(logo.left.join(" ")).toContain("YUKIOSHI")
  expect(logo.right.join(" ")).toContain("CODE")
  expect(epilogue).toContain("yukioshi -s ses_123")
})
