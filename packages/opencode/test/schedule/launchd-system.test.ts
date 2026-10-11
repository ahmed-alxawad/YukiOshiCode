import { describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import {
  cronToLaunchdPlist,
  cronToLaunchdSchedule,
  launchctlBootstrapArgs,
  launchctlBootoutArgs,
  launchdPlistPath,
  syncLaunchdSchedule,
  type LaunchctlRunner,
} from "../../src/schedule/launchd"
import { CRON_BLOCK_END, CRON_BLOCK_START, syncSystemSchedule } from "../../src/schedule/system"
import type { ScheduleJob } from "../../src/schedule/store"

const job: ScheduleJob = {
  id: "daily_1",
  name: "Daily summary",
  cron: "45 14 * * 1-5",
  prompt: "summarize commits",
  directory: "/Users/alice/project",
  auto: false,
  enabled: true,
  createdAt: 0,
}

describe("macOS launchd scheduled jobs", () => {
  it("writes XML-safe ProgramArguments, environment, working directory, and calendar schedule", () => {
    const plist = cronToLaunchdPlist(
      job.id,
      job.cron,
      "/Applications/Yuki & <Oshi>/yukioshi",
      "/Users/alice/project & <main>",
      "/Users/alice",
      "/usr/local/bin:/bin&",
      { XDG_CONFIG_HOME: "/Users/alice/.config/&<yuki>\"'" },
    )

    expect(plist).toContain("<key>Label</key>\n  <string>com.yukioshi.schedule.daily_1</string>")
    expect(plist).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>/Applications/Yuki &amp; &lt;Oshi&gt;/yukioshi</string>\n    <string>schedule</string>\n    <string>run</string>\n    <string>daily_1</string>",
    )
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/Users/alice/project &amp; &lt;main&gt;</string>")
    expect(plist).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/bin&amp;</string>")
    expect(plist).toContain("<key>HOME</key>\n    <string>/Users/alice</string>")
    expect(plist).toContain(
      "<key>XDG_CONFIG_HOME</key>\n    <string>/Users/alice/.config/&amp;&lt;yuki&gt;&quot;&apos;</string>",
    )
    expect(plist).toContain("<key>StartCalendarInterval</key>")
    expect(plist).toContain("<key>Weekday</key>\n      <integer>1</integer>")
    expect(plist).toContain("<key>Weekday</key>\n      <integer>5</integer>")
    expect(plist).not.toContain("<key>StartInterval</key>")
  })

  it("maps repeating minutes to exact calendar entries and keeps cron day OR semantics", () => {
    // Calendar entries keep cron's clock alignment (:00, :15, :30, :45); StartInterval would drift from it.
    expect(cronToLaunchdSchedule("*/15 * * * *")).toEqual({
      type: "calendar",
      intervals: [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }],
    })
    const plist = cronToLaunchdPlist(job.id, "*/15 * * * *", "/opt/yukioshi", job.directory, "/Users/alice", "/usr/bin")
    expect(plist).toContain("<key>StartCalendarInterval</key>")
    expect(plist).not.toContain("<key>StartInterval</key>")
    expect(cronToLaunchdSchedule("0 9 13 * 5")).toEqual({
      type: "calendar",
      intervals: [
        { Minute: 0, Hour: 9, Day: 13 },
        { Minute: 0, Hour: 9, Weekday: 5 },
      ],
    })
  })

  // LaunchAgents are a macOS feature and build POSIX paths; Windows path semantics do not apply.
  it.skipIf(process.platform === "win32")("constructs user-scoped launchctl arguments and rejects unsafe ids and paths", () => {
    const plistPath = launchdPlistPath("/Users/alice", "daily_1")
    expect(plistPath).toBe("/Users/alice/Library/LaunchAgents/com.yukioshi.schedule.daily_1.plist")
    expect(launchctlBootstrapArgs(501, plistPath)).toEqual(["bootstrap", "gui/501", plistPath])
    expect(launchctlBootoutArgs(501, plistPath)).toEqual(["bootout", "gui/501", plistPath])

    expect(() => launchdPlistPath("/Users/alice", "../other")).toThrow("Invalid job ID")
    expect(() => launchctlBootstrapArgs(501, "relative.plist")).toThrow("absolute path")
    expect(() =>
      cronToLaunchdPlist(job.id, job.cron, "relative-yukioshi", job.directory, "/Users/alice", "/usr/bin"),
    ).toThrow("absolute path")
  })

  it("uses a fake launchctl to bootstrap updates and boot out removed LaunchAgents", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-test-"))
    const plistPath = launchdPlistPath(home, job.id)
    const calls: string[][] = []
    const launchctl: LaunchctlRunner = async (args) => {
      calls.push(args)
    }
    const options = {
      binary: "/opt/yukioshi",
      home,
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
      uid: 501,
      launchctl,
    }

    try {
      await syncLaunchdSchedule([{ ...job, directory: home }], options)
      expect(calls).toEqual([["bootstrap", "gui/501", plistPath]])
      expect(await fs.readFile(plistPath, "utf8")).toContain("<string>/opt/yukioshi</string>")

      await syncLaunchdSchedule([{ ...job, cron: "0 15 * * *", directory: home }], options)
      expect(calls.slice(1)).toEqual([
        ["bootout", "gui/501", plistPath],
        ["bootstrap", "gui/501", plistPath],
      ])

      await syncLaunchdSchedule([], options)
      expect(calls.at(-1)).toEqual(["bootout", "gui/501", plistPath])
      await expect(fs.access(plistPath)).rejects.toThrow()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("falls back to cron after fake launchctl failure and clears legacy cron after launchd succeeds", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-launchd-fallback-test-"))
    const crontab = path.join(home, "crontab")
    const plistPath = launchdPlistPath(home, job.id)
    const oldTestHome = process.env.YUKIOSHI_TEST_HOME
    const oldCrontab = process.env.YUKIOSHI_CRONTAB
    const oldBinary = process.env.YUKIOSHI_BINARY_PATH
    process.env.YUKIOSHI_TEST_HOME = home
    process.env.YUKIOSHI_CRONTAB = crontab
    process.env.YUKIOSHI_BINARY_PATH = "/opt/yukioshi"

    try {
      await syncSystemSchedule([{ ...job, directory: home }], {
        platform: "darwin",
        launchctl: async () => {
          throw new Error("fake launchctl failure")
        },
      })
      const fallback = await fs.readFile(crontab, "utf8")
      expect(fallback).toContain(CRON_BLOCK_START)
      expect(fallback).toContain("schedule run daily_1")
      await expect(fs.access(plistPath)).rejects.toThrow()

      await syncSystemSchedule([{ ...job, directory: home }], { platform: "darwin", launchctl: async () => {} })
      expect(await fs.readFile(crontab, "utf8")).not.toContain(CRON_BLOCK_END)
      await expect(fs.access(plistPath)).resolves.toBeNull()

      await syncSystemSchedule([], { platform: "darwin", launchctl: async () => {} })
      await expect(fs.access(plistPath)).rejects.toThrow()
      expect(await fs.readFile(crontab, "utf8")).not.toContain(CRON_BLOCK_START)
    } finally {
      if (oldTestHome === undefined) delete process.env.YUKIOSHI_TEST_HOME
      else process.env.YUKIOSHI_TEST_HOME = oldTestHome
      if (oldCrontab === undefined) delete process.env.YUKIOSHI_CRONTAB
      else process.env.YUKIOSHI_CRONTAB = oldCrontab
      if (oldBinary === undefined) delete process.env.YUKIOSHI_BINARY_PATH
      else process.env.YUKIOSHI_BINARY_PATH = oldBinary
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
