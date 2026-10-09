import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { renameWithRetry } from "../../src/schedule/store"
import { renameWithRetry as trustRenameWithRetry } from "../../src/project/trust"

function flaky(code: string, failures: number) {
  let calls = 0
  const rename = async () => {
    calls++
    if (calls <= failures) throw Object.assign(new Error(code), { code })
  }
  return { rename, calls: () => calls }
}

for (const [name, fn] of [
  ["schedule store", renameWithRetry],
  ["project trust", trustRenameWithRetry],
] as const) {
  describe(`renameWithRetry (${name})`, () => {
    it("retries transient EPERM/EBUSY/EACCES and then succeeds", async () => {
      for (const code of ["EPERM", "EBUSY", "EACCES"]) {
        const f = flaky(code, 3)
        await fn("a", "b", f.rename, 1)
        expect(f.calls()).toBe(4)
      }
    })

    it("gives up after 5 tries", async () => {
      const f = flaky("EBUSY", 99)
      await expect(fn("a", "b", f.rename, 1)).rejects.toThrow("EBUSY")
      expect(f.calls()).toBe(5)
    })

    it("does not retry other errors", async () => {
      const f = flaky("ENOENT", 99)
      await expect(fn("a", "b", f.rename, 1)).rejects.toThrow("ENOENT")
      expect(f.calls()).toBe(1)
    })
  })
}

describe("saveJobs file mode", () => {
  it.skipIf(process.platform === "win32")("writes jobs.json with mode 0600", async () => {
    const { saveJobs, getJobsPath } = await import("../../src/schedule/store")
    await saveJobs([])
    const st = await fs.stat(getJobsPath())
    expect(st.mode & 0o777).toBe(0o600)
    expect(os.tmpdir()).toBeTruthy()
    expect(path.basename(getJobsPath())).toBe("jobs.json")
  })
})
