import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { AppLayer } from "../../src/effect/app-runtime"

test("AppLayer defers construction until it is provided", () => {
  expect(AppLayer).toBeDefined()
  const source = readFileSync(new URL("../../src/effect/app-runtime.ts", import.meta.url), "utf8")
  expect(source).toMatch(/export const AppLayer = Layer\.suspend\(buildAppLayer\)/)
  expect(source).not.toMatch(/export const AppLayer = AppNodeBuilderV1\.build/)
})
