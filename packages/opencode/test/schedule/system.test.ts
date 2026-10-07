import { describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import {
  updateCrontabBlock,
  buildCronLine,
  carriedEnv,
  cronQuote,
  readCrontab,
  writeCrontab,
  CRON_BLOCK_START,
  CRON_BLOCK_END,
} from "../../src/schedule/system"
import { cronToSchtasksArgs } from "../../src/schedule/windows"
import type { ScheduleJob } from "../../src/schedule/store"

const fakeJob: ScheduleJob = {
  id: "job12345",
  name: "daily summary",
  cron: "0 9 * * 1-5",
  prompt: "summarize git commits",
  directory: "/home/user/repo",
  auto: false,
  enabled: true,
  createdAt: 1728250000000,
}

const fakeJob2: ScheduleJob = {
  id: "job67890",
  name: "hourly check",
  cron: "0 * * * *",
  prompt: "check status",
  directory: "/home/user/repo",
  auto: true,
  enabled: true,
  createdAt: 1728250000000,
}

describe("crontab block management", () => {
  const binary = "/usr/local/bin/yukioshi"
  const home = "/home/user"
  const pathEnv = "/usr/bin:/bin"

  it("adds block to empty crontab", () => {
    const updated = updateCrontabBlock("", [fakeJob], binary, home, pathEnv)
    expect(updated).toContain(CRON_BLOCK_START)
    expect(updated).toContain(CRON_BLOCK_END)
    expect(updated).toContain(`0 9 * * 1-5 HOME="/home/user" PATH="/usr/bin:/bin" "/usr/local/bin/yukioshi" schedule run job12345`)
  })

  it("preserves other crontab lines when adding block", () => {
    const existing = "MAILTO=dev@example.com\n# user backup\n0 2 * * * /usr/local/bin/backup.sh\n"
    const updated = updateCrontabBlock(existing, [fakeJob], binary, home, pathEnv)

    expect(updated).toContain("MAILTO=dev@example.com")
    expect(updated).toContain("# user backup")
    expect(updated).toContain("0 2 * * * /usr/local/bin/backup.sh")
    expect(updated).toContain(CRON_BLOCK_START)
    expect(updated).toContain(CRON_BLOCK_END)
  })

  it("preserves lines before and after block when replacing block", () => {
    const existing = [
      "MAILTO=dev@example.com",
      CRON_BLOCK_START,
      "0 8 * * * HOME=\"/home/user\" PATH=\"/usr/bin\" \"/usr/local/bin/yukioshi\" schedule run oldjob",
      CRON_BLOCK_END,
      "# other cron job",
      "30 4 * * * /cleanup.sh",
      "",
    ].join("\n")

    const updated = updateCrontabBlock(existing, [fakeJob, fakeJob2], binary, home, pathEnv)

    expect(updated.startsWith("MAILTO=dev@example.com\n")).toBe(true)
    expect(updated).toContain(CRON_BLOCK_START)
    expect(updated).toContain("schedule run job12345")
    expect(updated).toContain("schedule run job67890")
    expect(updated).not.toContain("oldjob")
    expect(updated).toContain(CRON_BLOCK_END)
    expect(updated).toContain("# other cron job\n30 4 * * * /cleanup.sh")
  })

  it("removes block completely when all jobs are removed or disabled", () => {
    const existing = [
      "MAILTO=dev@example.com",
      CRON_BLOCK_START,
      "0 9 * * 1-5 HOME=\"/home/user\" PATH=\"/usr/bin\" \"/usr/local/bin/yukioshi\" schedule run job12345",
      CRON_BLOCK_END,
      "30 4 * * * /cleanup.sh",
      "",
    ].join("\n")

    const updated = updateCrontabBlock(existing, [], binary, home, pathEnv)

    expect(updated).not.toContain(CRON_BLOCK_START)
    expect(updated).not.toContain(CRON_BLOCK_END)
    expect(updated).toContain("MAILTO=dev@example.com")
    expect(updated).toContain("30 4 * * * /cleanup.sh")
  })

  it("omits disabled jobs from the block", () => {
    const disabledJob = { ...fakeJob, enabled: false }
    const updated = updateCrontabBlock("", [disabledJob, fakeJob2], binary, home, pathEnv)

    expect(updated).toContain("schedule run job67890")
    expect(updated).not.toContain("schedule run job12345")
  })
})

describe("Windows schtasks argument mapping", () => {
  const binary = "C:\\yukioshi\\bin\\yukioshi.exe"

  it("maps minute intervals", () => {
    const args1 = cronToSchtasksArgs("task1", "* * * * *", binary)
    expect(args1).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task1",
      "/TR",
      `"${binary}" schedule run task1`,
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/F",
    ])

    const args2 = cronToSchtasksArgs("task2", "*/15 * * * *", binary)
    expect(args2).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task2",
      "/TR",
      `"${binary}" schedule run task2`,
      "/SC",
      "MINUTE",
      "/MO",
      "15",
      "/F",
    ])
  })

  it("maps hourly intervals", () => {
    const args1 = cronToSchtasksArgs("task1", "0 * * * *", binary)
    expect(args1).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task1",
      "/TR",
      `"${binary}" schedule run task1`,
      "/SC",
      "HOURLY",
      "/MO",
      "1",
      "/ST",
      "00:00",
      "/F",
    ])

    const args2 = cronToSchtasksArgs("task2", "30 */2 * * *", binary)
    expect(args2).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task2",
      "/TR",
      `"${binary}" schedule run task2`,
      "/SC",
      "HOURLY",
      "/MO",
      "2",
      "/ST",
      "00:30",
      "/F",
    ])
  })

  it("maps daily schedules", () => {
    const args = cronToSchtasksArgs("task1", "45 14 * * *", binary)
    expect(args).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task1",
      "/TR",
      `"${binary}" schedule run task1`,
      "/SC",
      "DAILY",
      "/ST",
      "14:45",
      "/F",
    ])
  })

  it("maps weekly schedules", () => {
    const args1 = cronToSchtasksArgs("task1", "0 9 * * 1-5", binary)
    expect(args1).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task1",
      "/TR",
      `"${binary}" schedule run task1`,
      "/SC",
      "WEEKLY",
      "/D",
      "MON,TUE,WED,THU,FRI",
      "/ST",
      "09:00",
      "/F",
    ])

    const args2 = cronToSchtasksArgs("task2", "30 10 * * MON,WED,FRI", binary)
    expect(args2).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task2",
      "/TR",
      `"${binary}" schedule run task2`,
      "/SC",
      "WEEKLY",
      "/D",
      "MON,WED,FRI",
      "/ST",
      "10:30",
      "/F",
    ])
  })

  it("maps monthly schedules", () => {
    const args = cronToSchtasksArgs("task1", "0 12 1 * *", binary)
    expect(args).toEqual([
      "/Create",
      "/TN",
      "YukiOshi\\task1",
      "/TR",
      `"${binary}" schedule run task1`,
      "/SC",
      "MONTHLY",
      "/D",
      "1",
      "/ST",
      "12:00",
      "/F",
    ])
  })

  it("refuses unsupported cron expressions with a clear message", () => {
    expect(() => cronToSchtasksArgs("task1", "0 0 1 5 *", binary)).toThrow(
      "cannot be scheduled with Windows schtasks",
    )
    expect(() => cronToSchtasksArgs("task2", "1,2,3 * * * *", binary)).toThrow(
      "cannot be scheduled with Windows schtasks",
    )
  })
})

describe("fake crontab file isolation via YUKIOSHI_CRONTAB", () => {
  it("reads and writes fake crontab without touching real crontab", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yk-cron-test-"))
    const fakeCrontab = path.join(tempDir, "crontab")

    const prev = process.env.YUKIOSHI_CRONTAB
    process.env.YUKIOSHI_CRONTAB = fakeCrontab

    try {
      // Non-existent fake file returns empty string
      const initial = await readCrontab()
      expect(initial).toBe("")

      // Write content
      const sample = "# initial user crontab\n0 0 * * * /backup.sh\n"
      await writeCrontab(sample)

      // Read content back
      const readBack = await readCrontab()
      expect(readBack).toBe(sample)
    } finally {
      if (prev !== undefined) process.env.YUKIOSHI_CRONTAB = prev
      else delete process.env.YUKIOSHI_CRONTAB
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("cron line environment", () => {
  const job = { id: "job1", name: "n", cron: "0 9 * * *", prompt: "p", directory: "/d", enabled: true, auto: false, createdAt: 0 } as any

  it("carries config and data folder settings but never secrets", () => {
    const env = carriedEnv({
      XDG_STATE_HOME: "/data/state",
      YUKIOSHI_CONFIG: "/etc/yk.json",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_x",
      XDG_DATA_HOME: "",
    })
    expect(env).toEqual({ XDG_STATE_HOME: "/data/state", YUKIOSHI_CONFIG: "/etc/yk.json" })
    const line = buildCronLine(job, "/bin/yukioshi", "/home/u", "/usr/bin", env)
    expect(line).toBe(
      `0 9 * * * HOME="/home/u" PATH="/usr/bin" XDG_STATE_HOME="/data/state" YUKIOSHI_CONFIG="/etc/yk.json" "/bin/yukioshi" schedule run job1`,
    )
    expect(line).not.toContain("sk-secret")
  })

  it("escapes characters that would break the shell or cron", () => {
    expect(cronQuote('/home/a "b"/$x`y`\\z 100%')).toBe('"/home/a \\"b\\"/\\$x\\`y\\`\\\\z 100\\%"')
    expect(cronQuote("/usr/bin")).toBe('"/usr/bin"')
  })
})

