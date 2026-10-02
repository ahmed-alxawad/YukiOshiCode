import { expect, test } from "bun:test"
import { OpenCode, YukiOshi } from "../src"

test("SDK Next exposes the YukiOshi namespace with an OpenCode alias", () => {
  expect(YukiOshi.create).toBe(OpenCode.create)
  expect(YukiOshi.Service).toBe(OpenCode.Service)
  expect(YukiOshi.layer).toBe(OpenCode.layer)
})
