import { describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { validateCron } from "../../src/schedule/cron"
import { buildCronLine, cronQuote } from "../../src/schedule/system"
import { cronToSchtasksArgs, schtasksDeleteArgs } from "../../src/schedule/windows"
import {
  assertSafeJobId,
  getJobLogsDir,
  acquireJobLock,
  writeRunLog,
  type ScheduleJob,
} from "../../src/schedule/store"

describe("scheduled tasks security checks", () => {
  it("rejects crontab injection via newlines in cron expression", () => {
    expect(() => validateCron("* * * *\n*")).toThrow("contains newline")
    expect(() => validateCron("* * * * *\n0 0 * * * evil_command")).toThrow("contains newline")
    expect(() => validateCron("* * * * *\r\n0 0 * * * evil_command")).toThrow("contains newline")
  })

  it("cronQuote rejects newlines in values", () => {
    expect(() => cronQuote("hello\nworld")).toThrow("Cannot quote value containing newline in crontab")
    expect(() => cronQuote("foo\rbar")).toThrow("Cannot quote value containing newline in crontab")
  })

  it("buildCronLine validates job ID and environment variable names", () => {
    const safeJob: ScheduleJob = {
      id: "safe-job-123",
      name: "safe",
      cron: "0 * * * *",
      prompt: "hi",
      directory: "/tmp",
      auto: false,
      enabled: true,
      createdAt: 0,
    }

    expect(() => buildCronLine(safeJob, "/bin/yk", "/home/u", "/bin")).not.toThrow()

    // Hostile job IDs
    const hostileIds = [
      "job; rm -rf /",
      "job\n* * * * * evil",
      "../evil",
      "job name with spaces",
      "job`id`",
      "job$ID",
    ]

    for (const badId of hostileIds) {
      expect(() =>
        buildCronLine({ ...safeJob, id: badId }, "/bin/yk", "/home/u", "/bin"),
      ).toThrow("Invalid job ID")
    }

    // Hostile env variable names
    expect(() =>
      buildCronLine(safeJob, "/bin/yk", "/home/u", "/bin", { "BAD NAME": "val" }),
    ).toThrow("Invalid environment variable name")
    expect(() =>
      buildCronLine(safeJob, "/bin/yk", "/home/u", "/bin", { "FOO;BAR": "val" }),
    ).toThrow("Invalid environment variable name")
  })

  it("windows schtasks validates job ID and binary path", () => {
    expect(() => cronToSchtasksArgs("safe_job-1", "0 * * * *", "C:\\bin\\yk.exe")).not.toThrow()

    // Hostile IDs
    const hostileIds = [
      "../../evil",
      "job /TR evil",
      'job" & calc.exe',
      "job\nwith\nnewlines",
    ]

    for (const badId of hostileIds) {
      expect(() => cronToSchtasksArgs(badId, "0 * * * *", "C:\\bin\\yk.exe")).toThrow("Invalid job ID")
      expect(() => schtasksDeleteArgs(badId)).toThrow("Invalid job ID")
    }

    // Hostile binary
    expect(() => cronToSchtasksArgs("safe", "0 * * * *", 'C:\\bin\\yk.exe" & calc.exe')).toThrow(
      "Invalid binary path",
    )
    expect(() => cronToSchtasksArgs("safe", "0 * * * *", "C:\\bin\\yk.exe\ncalc.exe")).toThrow(
      "Invalid binary path",
    )
  })

  it("store rejects job IDs with path traversal or metacharacters", () => {
    expect(() => assertSafeJobId("normal_job-123")).not.toThrow()

    const badIds = [
      "../traversal",
      "../../etc/passwd",
      "/absolute/path",
      "job with spaces",
      "job\nnewline",
      "..",
      ".",
    ]

    for (const bad of badIds) {
      expect(() => assertSafeJobId(bad)).toThrow("Invalid job ID")
      expect(() => getJobLogsDir(bad)).toThrow("Invalid job ID")
    }
  })

  it("writeRunLog and acquireJobLock refuse or neutralize planted symlinks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yk-sec-test-"))
    const targetFile = path.join(tempDir, "sensitive-target.txt")
    await fs.writeFile(targetFile, "original sensitive data", "utf8")

    const jobId = `symlink-test-${Date.now()}`
    const logDir = getJobLogsDir(jobId)
    await fs.mkdir(logDir, { recursive: true })

    // Plant a symlink at the lock file path
    const lockFile = path.join(logDir, "lock")
    await fs.symlink(targetFile, lockFile)

    // acquireJobLock should detect and unlink the planted symlink without overwriting targetFile
    const lock = await acquireJobLock(jobId)
    expect(lock).not.toBeNull()
    const targetContent = await fs.readFile(targetFile, "utf8")
    expect(targetContent).toBe("original sensitive data")
    await lock!.release()

    // Plant a symlink at a log file path
    const logTime = Date.now()
    const logPath = path.join(logDir, `${logTime}.log`)
    await fs.symlink(targetFile, logPath)

    // writeRunLog should refuse to write to a symlink
    expect(writeRunLog(jobId, "new log data", logTime)).rejects.toThrow("Refusing to write log to symlink")

    // The sensitive target must not be overwritten
    const targetAfter = await fs.readFile(targetFile, "utf8")
    expect(targetAfter).toBe("original sensitive data")

    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.rm(logDir, { recursive: true, force: true })
  })

  it("refuses a job log folder that is a symlink to somewhere else", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "yk-sec-outside-"))
    const jobId = `dirlink-${Date.now()}`
    const logDir = getJobLogsDir(jobId)
    await fs.mkdir(path.dirname(logDir), { recursive: true })
    await fs.symlink(outside, logDir)

    await expect(writeRunLog(jobId, "data", Date.now())).rejects.toThrow("symbolic link")
    await expect(acquireJobLock(jobId)).rejects.toThrow("symbolic link")
    expect(await fs.readdir(outside)).toEqual([])

    await fs.rm(logDir, { force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it("does not read a planted lock symlink as a live lock", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yk-sec-lock-"))
    const target = path.join(tempDir, "pid.json")
    // A live pid: if the symlink were followed, the lock would look held.
    await fs.writeFile(target, JSON.stringify({ pid: process.pid, time: Date.now() }), "utf8")
    const jobId = `locklink-${Date.now()}`
    const logDir = getJobLogsDir(jobId)
    await fs.mkdir(logDir, { recursive: true })
    await fs.symlink(target, path.join(logDir, "lock"))

    const lock = await acquireJobLock(jobId)
    expect(lock).not.toBeNull()
    await lock!.release()

    await fs.rm(logDir, { recursive: true, force: true })
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it("lets only one of two simultaneous runs take the lock", async () => {
    const jobId = `race-${Date.now()}`
    const results = await Promise.all([acquireJobLock(jobId), acquireJobLock(jobId)])
    const held = results.filter((r) => r !== null)
    expect(held.length).toBe(1)
    await held[0]!.release()
    await fs.rm(getJobLogsDir(jobId), { recursive: true, force: true })
  })
})
