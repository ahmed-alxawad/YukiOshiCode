import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

describe("binary smoke scheduler environment", () => {
  it("pins the test home explicitly for platform scheduler checks", () => {
    const smoke = fs.readFileSync(path.join(import.meta.dir, "../../script/smoke.ts"), "utf8")
    expect(smoke).toContain("YUKIOSHI_TEST_HOME: home")
  })
})
