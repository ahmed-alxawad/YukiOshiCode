import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { restrict } from "../src/audit"

describe("audit restrict", () => {
  test.skipIf(process.platform === "win32")("tightens the mode without warning on success", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yk-audit-"))
    try {
      const file = path.join(dir, "a.jsonl")
      await fs.writeFile(file, "x", { mode: 0o644 })
      const warnings: string[] = []
      await restrict(file, 0o600, (m) => warnings.push(m))
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect(warnings).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("warns once per path instead of swallowing a failed chmod", async () => {
    const missing = path.join(os.tmpdir(), "yk-audit-missing-" + Date.now(), "a.jsonl")
    const warnings: string[] = []
    await restrict(missing, 0o600, (m) => warnings.push(m))
    await restrict(missing, 0o600, (m) => warnings.push(m))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(missing)
  })
})
