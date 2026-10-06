import { describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import {
  acquireJobLock,
  writeRunLog,
  getRunLogs,
  pruneLogs,
  loadJobs,
  saveJobs,
  type ScheduleJob,
} from "../../src/schedule/store"

describe("schedule store, logging, and concurrency lock", () => {
  it("acquires exclusive lock and blocks concurrent acquire on same job", async () => {
    const jobId = `lock-test-${Date.now()}`
    const lock1 = await acquireJobLock(jobId)
    expect(lock1).not.toBeNull()

    // Second acquire while lock1 is held must return null
    const lock2 = await acquireJobLock(jobId)
    expect(lock2).toBeNull()

    // Release lock1
    await lock1!.release()

    // Now lock3 can be acquired
    const lock3 = await acquireJobLock(jobId)
    expect(lock3).not.toBeNull()
    await lock3!.release()
  })

  it("prunes logs to keep only the last 50 runs", async () => {
    const jobId = `prune-test-${Date.now()}`
    const baseTime = Date.now() - 100_000

    // Write 55 logs
    for (let i = 0; i < 55; i++) {
      await writeRunLog(jobId, `log content ${i}`, baseTime + i * 1000)
    }

    const logs = await getRunLogs(jobId)
    // pruneLogs is called inside writeRunLog, so at most 50 remain
    expect(logs.length).toBe(50)

    // The most recent log should be i = 54
    const latest = logs[0]
    expect(latest.time).toBe(baseTime + 54 * 1000)

    // Cleanup
    await pruneLogs(jobId, 0)
  })
})
