import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { acquireJobLock, getJobLogsDir, processStartTime } from "../../src/schedule/store"

async function plant(jobId: string, body: object) {
  const dir = getJobLogsDir(jobId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "lock"), JSON.stringify(body), "utf8")
  return dir
}

describe("job lock liveness", () => {
  it("keeps a lock whose pid and start time match a live process", async () => {
    const jobId = `live-${Date.now()}`
    const dir = await plant(jobId, { pid: process.pid, time: Date.now(), start: processStartTime(process.pid) })
    expect(await acquireJobLock(jobId)).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== "linux")("treats a lock as stale when the pid was reused (start time differs)", async () => {
    const jobId = `reused-${Date.now()}`
    const dir = await plant(jobId, { pid: process.pid, time: Date.now(), start: "1" })
    const lock = await acquireJobLock(jobId)
    expect(lock).not.toBeNull()
    await lock!.release()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("treats a lock older than 24h as stale even with a live pid", async () => {
    const jobId = `old-${Date.now()}`
    const dir = await plant(jobId, { pid: process.pid, time: Date.now() - 25 * 3600_000 })
    const lock = await acquireJobLock(jobId)
    expect(lock).not.toBeNull()
    await lock!.release()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("keeps a lock older than 24h when the job timeout is longer", async () => {
    const jobId = `long-${Date.now()}`
    const dir = await plant(jobId, { pid: process.pid, time: Date.now() - 25 * 3600_000 })
    expect(await acquireJobLock(jobId, 48 * 3600_000)).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
