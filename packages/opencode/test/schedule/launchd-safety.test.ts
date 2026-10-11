import { describe, expect, it } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import {
  cronToLaunchdPlist,
  cronToLaunchdSchedule,
  launchdPlistPath,
  syncLaunchdSchedule,
  type LaunchctlRunner,
} from "../../src/schedule/launchd"
import { CRON_BLOCK_START, syncSystemSchedule } from "../../src/schedule/system"
import type { ScheduleJob } from "../../src/schedule/store"

function scheduledJob(directory: string, overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "calendar_job",
    name: "Calendar job",
    cron: "0 9 * * *",
    prompt: "run",
    directory,
    auto: false,
    enabled: true,
    createdAt: 0,
    ...overrides,
  }
}

function launchdOptions(home: string, launchctl: LaunchctlRunner) {
  return {
    binary: "/opt/yukioshi",
    home,
    pathEnv: "/usr/bin:/bin",
    uid: 501,
    launchctl,
  }
}

describe("launchd scheduling safety", () => {
  it("keeps cron minute-step alignment and falls back to cron when calendar expansion is bounded", async () => {
    expect(cronToLaunchdSchedule("*/15 * * * *")).toEqual({
      type: "calendar",
      intervals: [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }],
    })
    const plist = cronToLaunchdPlist(
      "calendar_job",
      "*/15 * * * *",
      "/opt/yukioshi",
      "/tmp/project",
      "/tmp/home",
      "/usr/bin:/bin",
    )
    expect(plist).toContain("<key>StartCalendarInterval</key>")
    expect(plist).not.toContain("<key>StartInterval</key>")

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-calendar-fallback-"))
    const crontab = path.join(home, "crontab")
    const oldHome = process.env.YUKIOSHI_TEST_HOME
    const oldCrontab = process.env.YUKIOSHI_CRONTAB
    const oldBinary = process.env.YUKIOSHI_BINARY_PATH
    process.env.YUKIOSHI_TEST_HOME = home
    process.env.YUKIOSHI_CRONTAB = crontab
    process.env.YUKIOSHI_BINARY_PATH = "/opt/yukioshi"
    const calls: string[][] = []

    try {
      const oversizedCalendarJob = scheduledJob(home, { cron: "0-58 0-22 1-30 1-11 *" })
      await syncSystemSchedule([oversizedCalendarJob], {
        platform: "darwin",
        launchctl: async (args) => {
          calls.push(args)
        },
      })

      expect(calls).toEqual([])
      const fallback = await fs.readFile(crontab, "utf8")
      expect(fallback).toContain(CRON_BLOCK_START)
      expect(fallback).toContain("0-58 0-22 1-30 1-11 *")
    } finally {
      if (oldHome === undefined) delete process.env.YUKIOSHI_TEST_HOME
      else process.env.YUKIOSHI_TEST_HOME = oldHome
      if (oldCrontab === undefined) delete process.env.YUKIOSHI_CRONTAB
      else process.env.YUKIOSHI_CRONTAB = oldCrontab
      if (oldBinary === undefined) delete process.env.YUKIOSHI_BINARY_PATH
      else process.env.YUKIOSHI_BINARY_PATH = oldBinary
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it("restores a working plist after a failed update and retains the backup when recovery fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-rollback-"))
    const job = scheduledJob(home)
    const plistPath = launchdPlistPath(home, job.id)
    const backupPath = `${plistPath}.yukioshi-backup`
    const calls: string[][] = []
    let bootstrapCalls = 0
    const launchctl: LaunchctlRunner = async (args) => {
      calls.push(args)
      if (args[0] !== "bootstrap") return
      bootstrapCalls += 1
      if (bootstrapCalls === 2) throw new Error("new bootstrap failed")
    }

    try {
      await syncLaunchdSchedule([job], launchdOptions(home, launchctl))
      const originalPlist = await fs.readFile(plistPath, "utf8")

      await expect(
        syncLaunchdSchedule([{ ...job, cron: "30 10 * * *" }], launchdOptions(home, launchctl)),
      ).rejects.toThrow("new bootstrap failed")
      expect(await fs.readFile(plistPath, "utf8")).toBe(originalPlist)
      expect(calls.slice(-4)).toEqual([
        ["bootout", "gui/501", plistPath],
        ["bootstrap", "gui/501", plistPath],
        ["bootout", "gui/501", plistPath],
        ["bootstrap", "gui/501", plistPath],
      ])
      await expect(fs.access(backupPath)).rejects.toThrow()

      let failedRecoveryBootstrapCalls = 0
      const recoveryFailureRunner: LaunchctlRunner = async (args) => {
        if (args[0] !== "bootstrap") return
        failedRecoveryBootstrapCalls += 1
        if (failedRecoveryBootstrapCalls >= 1) throw new Error("new and restored bootstrap failed")
      }
      await expect(
        syncLaunchdSchedule([{ ...job, cron: "45 10 * * *" }], launchdOptions(home, recoveryFailureRunner)),
      ).rejects.toThrow("Original plist backup preserved")
      expect(await fs.readFile(plistPath, "utf8")).toBe(originalPlist)
      expect(await fs.readFile(backupPath, "utf8")).toBe(originalPlist)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it("refuses a managed plist symlink before it can be written, chmodded, or removed", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-symlink-"))
    const job = scheduledJob(home)
    const plistPath = launchdPlistPath(home, job.id)
    const targetPath = path.join(home, "sensitive.plist")
    const targetContents = "do not overwrite"
    const calls: string[][] = []

    try {
      await fs.mkdir(path.dirname(plistPath), { recursive: true })
      await fs.writeFile(targetPath, targetContents, { encoding: "utf8", mode: 0o640 })
      const targetMode = (await fs.stat(targetPath)).mode & 0o777
      await fs.symlink(targetPath, plistPath)
      const launchctl: LaunchctlRunner = async (args) => {
        calls.push(args)
      }

      await expect(syncLaunchdSchedule([job], launchdOptions(home, launchctl))).rejects.toThrow("symbolic link")
      await expect(syncLaunchdSchedule([], launchdOptions(home, launchctl))).rejects.toThrow("symbolic link")
      expect(await fs.readFile(targetPath, "utf8")).toBe(targetContents)
      expect((await fs.stat(targetPath)).mode & 0o777).toBe(targetMode)
      expect((await fs.lstat(plistPath)).isSymbolicLink()).toBe(true)
      expect(calls).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
