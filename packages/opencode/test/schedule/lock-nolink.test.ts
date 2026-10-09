import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { acquireJobLock, getJobLogsDir } from "../../src/schedule/store"

const realLink = fs.link

afterEach(() => {
  fs.link = realLink
})

function noHardLinks(code: string) {
  fs.link = (async () => {
    throw Object.assign(new Error(code), { code })
  }) as typeof fs.link
}

describe("job lock without hard link support", () => {
  for (const code of ["EPERM", "ENOTSUP", "ENOSYS"]) {
    it(`falls back to an exclusive open when link fails with ${code}`, async () => {
      noHardLinks(code)
      const jobId = `nolink-${code}-${Date.now()}`
      const lock = await acquireJobLock(jobId)
      expect(lock).not.toBeNull()

      const lockFile = path.join(getJobLogsDir(jobId), "lock")
      const body = JSON.parse(await fs.readFile(lockFile, "utf8"))
      expect(body.pid).toBe(process.pid)

      // The fallback lock is still exclusive
      expect(await acquireJobLock(jobId)).toBeNull()

      await lock!.release()
      await fs.rm(getJobLogsDir(jobId), { recursive: true, force: true })
    })
  }

  it("still throws on unrelated link errors", async () => {
    noHardLinks("EIO")
    const jobId = `nolink-eio-${Date.now()}`
    await expect(acquireJobLock(jobId)).rejects.toThrow("EIO")
    await fs.rm(getJobLogsDir(jobId), { recursive: true, force: true })
  })
})
