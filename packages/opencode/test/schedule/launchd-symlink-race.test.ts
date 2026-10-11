import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { launchdPlistPath, syncLaunchdSchedule, type LaunchctlRunner } from "../../src/schedule/launchd"
import type { ScheduleJob } from "../../src/schedule/store"

function scheduledJob(directory: string, overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "symlink_race_job",
    name: "Symlink race job",
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

describe("launchd plist symlink races", () => {
  it("does not follow a plist symlink swapped in after validation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-symlink-race-"))
    const job = scheduledJob(home)
    const plistPath = launchdPlistPath(home, job.id)
    const targetPath = path.join(home, "sensitive.txt")
    const targetContents = "do not overwrite"
    const launchctl: LaunchctlRunner = async () => {}

    try {
      await syncLaunchdSchedule([job], launchdOptions(home, launchctl))
      await fs.writeFile(targetPath, targetContents, { encoding: "utf8", mode: 0o640 })

      const originalLstat = fs.lstat
      const mutableFs = fs as { lstat: typeof fs.lstat }
      let plistChecks = 0
      mutableFs.lstat = (async (candidate: string) => {
        const stats = await originalLstat(candidate)
        if (candidate === plistPath && ++plistChecks === 3) {
          await fs.rm(plistPath)
          await fs.symlink(targetPath, plistPath)
        }
        return stats
      }) as typeof fs.lstat

      try {
        await expect(
          syncLaunchdSchedule([{ ...job, cron: "30 10 * * *" }], launchdOptions(home, launchctl)),
        ).rejects.toThrow("symbolic link")
      } finally {
        mutableFs.lstat = originalLstat
      }

      expect(await fs.readFile(targetPath, "utf8")).toBe(targetContents)
      expect((await fs.lstat(plistPath)).isSymbolicLink()).toBe(true)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
