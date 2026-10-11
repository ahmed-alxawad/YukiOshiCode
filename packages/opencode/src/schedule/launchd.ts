// macOS LaunchAgent mapping for scheduled jobs.

import path from "path"
import fs from "fs/promises"
import { validateCron, type ParsedCron } from "./cron"
import { assertSafeJobId, type ScheduleJob } from "./store"

export const LAUNCHD_LABEL_PREFIX = "com.yukioshi.schedule."
export const LAUNCHD_PLIST_SUFFIX = ".plist"

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const INVALID_XML_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const MAX_CALENDAR_INTERVALS = 10_000

export interface LaunchdCalendarInterval {
  Minute?: number
  Hour?: number
  Day?: number
  Month?: number
  Weekday?: number
}

export type LaunchdSchedule =
  | { type: "interval"; seconds: number }
  | { type: "calendar"; intervals: LaunchdCalendarInterval[] }

/** Invokes launchctl without involving a shell. Tests can provide a fake runner. */
export type LaunchctlRunner = (args: string[]) => Promise<void>

export interface LaunchdSyncOptions {
  binary: string
  home: string
  pathEnv: string
  env?: Record<string, string>
  uid?: number
  launchctl?: LaunchctlRunner
}

function assertPlistText(value: string, name: string): void {
  if (INVALID_XML_CHARACTER.test(value)) {
    throw new Error(`Invalid ${name}: contains a control character that cannot be written to a plist`)
  }
}

function assertAbsolutePath(value: string, name: string): void {
  assertPlistText(value, name)
  if (!path.isAbsolute(value)) {
    throw new Error(`Invalid ${name}: expected an absolute path, got ${JSON.stringify(value)}`)
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function valuesOrWildcard(values: Set<number>, allValues: number): Array<number | undefined> {
  if (values.size === allValues) return [undefined]
  return [...values].sort((a, b) => a - b)
}

function addCalendarIntervals(
  target: LaunchdCalendarInterval[],
  cron: ParsedCron,
  includeDay: boolean,
  includeWeekday: boolean,
): void {
  const minutes = valuesOrWildcard(cron.minutes, 60)
  const hours = valuesOrWildcard(cron.hours, 24)
  const months = valuesOrWildcard(cron.months, 12)
  const days = includeDay ? valuesOrWildcard(cron.daysOfMonth, 31) : [undefined]
  const weekdays = includeWeekday ? valuesOrWildcard(cron.daysOfWeek, 7) : [undefined]

  for (const minute of minutes) {
    for (const hour of hours) {
      for (const month of months) {
        for (const day of days) {
          for (const weekday of weekdays) {
            const interval: LaunchdCalendarInterval = {}
            if (minute !== undefined) interval.Minute = minute
            if (hour !== undefined) interval.Hour = hour
            if (day !== undefined) interval.Day = day
            if (month !== undefined) interval.Month = month
            if (weekday !== undefined) interval.Weekday = weekday
            target.push(interval)
            if (target.length > MAX_CALENDAR_INTERVALS) {
              throw new Error(
                `Cron expression ${JSON.stringify(cron.raw)} expands to more than ${MAX_CALENDAR_INTERVALS} launchd calendar intervals`,
              )
            }
          }
        }
      }
    }
  }
}

function runsEveryMinute(cron: ParsedCron): boolean {
  return (
    cron.minutes.size === 60 &&
    cron.hours.size === 24 &&
    cron.daysOfMonth.size === 31 &&
    cron.months.size === 12 &&
    cron.daysOfWeek.size === 7
  )
}

function minuteIntervalSeconds(rawCron: string, cron: ParsedCron): number | undefined {
  if (runsEveryMinute(cron)) return 60

  const [minutes, hours, dayOfMonth, month, dayOfWeek] = rawCron.split(/\s+/)
  if (hours !== "*" || dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return undefined

  const match = /^\*\/(\d+)$/.exec(minutes)
  if (!match) return undefined
  const minutesPerRun = Number.parseInt(match[1], 10)

  // A cron step restarts at the top of each hour. It is a true fixed interval only when it divides an hour.
  if (minutesPerRun < 60 && 60 % minutesPerRun === 0) return minutesPerRun * 60
  return undefined
}

/** Maps supported five-field cron syntax to the launchd scheduling keys. */
export function cronToLaunchdSchedule(cronExpression: string): LaunchdSchedule {
  const cron = validateCron(cronExpression)
  const intervalSeconds = minuteIntervalSeconds(cron.raw, cron)
  if (intervalSeconds !== undefined) return { type: "interval", seconds: intervalSeconds }

  const intervals: LaunchdCalendarInterval[] = []
  if (cron.domRestricted && cron.dowRestricted) {
    // Cron uses OR semantics when both day-of-month and day-of-week are restricted. launchd arrays are ORed.
    addCalendarIntervals(intervals, cron, true, false)
    addCalendarIntervals(intervals, cron, false, true)
  } else {
    addCalendarIntervals(intervals, cron, cron.domRestricted, cron.dowRestricted)
  }

  return { type: "calendar", intervals }
}

export function launchdLabel(id: string): string {
  assertSafeJobId(id)
  return `${LAUNCHD_LABEL_PREFIX}${id}`
}

export function launchdDirectory(home: string): string {
  assertAbsolutePath(home, "home directory")
  return path.join(home, "Library", "LaunchAgents")
}

export function launchdPlistPath(home: string, id: string): string {
  const directory = launchdDirectory(home)
  const plistPath = path.join(directory, `${launchdLabel(id)}${LAUNCHD_PLIST_SUFFIX}`)
  if (path.dirname(plistPath) !== directory) {
    throw new Error(`LaunchAgent path for job ${JSON.stringify(id)} resolves outside ${directory}`)
  }
  return plistPath
}

export function launchctlBootstrapArgs(uid: number, plistPath: string): string[] {
  assertAbsolutePath(plistPath, "LaunchAgent plist path")
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`Invalid launchctl user id: ${uid}`)
  return ["bootstrap", `gui/${uid}`, plistPath]
}

export function launchctlBootoutArgs(uid: number, plistPath: string): string[] {
  assertAbsolutePath(plistPath, "LaunchAgent plist path")
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`Invalid launchctl user id: ${uid}`)
  return ["bootout", `gui/${uid}`, plistPath]
}

function launchdEnvironment(home: string, pathEnv: string, extraEnv: Record<string, string>): Record<string, string> {
  assertPlistText(pathEnv, "PATH")
  const result: Record<string, string> = { PATH: pathEnv, HOME: home }
  for (const [name, value] of Object.entries(extraEnv)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Invalid environment variable name for launchd: ${JSON.stringify(name)}`)
    }
    if (name === "PATH" || name === "HOME") {
      throw new Error(`Cannot override ${name} in a launchd scheduled job`)
    }
    assertPlistText(value, `environment variable ${name}`)
    result[name] = value
  }
  return result
}

function renderCalendarInterval(interval: LaunchdCalendarInterval, indent: string): string[] {
  const lines = [`${indent}<dict>`]
  for (const key of ["Minute", "Hour", "Day", "Month", "Weekday"] as const) {
    const value = interval[key]
    if (value !== undefined) {
      lines.push(`${indent}  <key>${key}</key>`, `${indent}  <integer>${value}</integer>`)
    }
  }
  lines.push(`${indent}</dict>`)
  return lines
}

function renderSchedule(schedule: LaunchdSchedule): string[] {
  if (schedule.type === "interval") {
    return ["  <key>StartInterval</key>", `  <integer>${schedule.seconds}</integer>`]
  }

  const lines = ["  <key>StartCalendarInterval</key>"]
  if (schedule.intervals.length === 1) return lines.concat(renderCalendarInterval(schedule.intervals[0], "  "))
  lines.push("  <array>")
  for (const interval of schedule.intervals) lines.push(...renderCalendarInterval(interval, "    "))
  lines.push("  </array>")
  return lines
}

/**
 * Builds the plist for one user LaunchAgent. Arguments are separate plist strings, so paths and job ids never
 * pass through a shell.
 */
export function cronToLaunchdPlist(
  id: string,
  cron: string,
  binary: string,
  workingDirectory: string,
  home: string,
  pathEnv: string,
  extraEnv: Record<string, string> = {},
): string {
  const label = launchdLabel(id)
  assertAbsolutePath(binary, "YukiOshi binary path")
  assertAbsolutePath(workingDirectory, "working directory")
  assertAbsolutePath(home, "home directory")
  const environment = launchdEnvironment(home, pathEnv, extraEnv)
  const schedule = cronToLaunchdSchedule(cron)

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(binary)}</string>`,
    "    <string>schedule</string>",
    "    <string>run</string>",
    `    <string>${xmlEscape(id)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
  ]
  for (const [name, value] of Object.entries(environment)) {
    lines.push(`    <key>${xmlEscape(name)}</key>`, `    <string>${xmlEscape(value)}</string>`)
  }
  lines.push("  </dict>", ...renderSchedule(schedule), "</dict>", "</plist>", "")
  return lines.join("\n")
}

export function launchdPlist(
  job: Pick<ScheduleJob, "id" | "cron" | "directory">,
  binary: string,
  home: string,
  pathEnv: string,
  extraEnv: Record<string, string> = {},
): string {
  return cronToLaunchdPlist(job.id, job.cron, binary, job.directory, home, pathEnv, extraEnv)
}

export async function runLaunchctl(args: string[]): Promise<void> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: "pipe" })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) {
    throw new Error(`launchctl ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`)
  }
}

function isNotLoadedError(error: unknown): boolean {
  return /could not find service|no such process|not loaded/i.test(String(error))
}

async function bootoutLaunchAgent(runner: LaunchctlRunner, uid: number, plistPath: string): Promise<void> {
  try {
    await runner(launchctlBootoutArgs(uid, plistPath))
  } catch (error) {
    // bootout reports an error when a valid plist was never bootstrapped. It is already absent in that case.
    if (!isNotLoadedError(error)) throw error
  }
}

interface ManagedLaunchAgent {
  id: string
  plistPath: string
}

async function managedLaunchAgents(directory: string): Promise<ManagedLaunchAgent[]> {
  let names: string[]
  try {
    names = await fs.readdir(directory)
  } catch (error: any) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  const agents: ManagedLaunchAgent[] = []
  for (const name of names) {
    if (!name.startsWith(LAUNCHD_LABEL_PREFIX) || !name.endsWith(LAUNCHD_PLIST_SUFFIX)) continue
    const id = name.slice(LAUNCHD_LABEL_PREFIX.length, -LAUNCHD_PLIST_SUFFIX.length)
    try {
      assertSafeJobId(id)
    } catch {
      continue
    }
    const plistPath = path.join(directory, name)
    if (path.dirname(plistPath) === directory) agents.push({ id, plistPath })
  }
  return agents
}

function launchdUid(uid: number | undefined): number {
  const result = uid ?? process.getuid?.()
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new Error("Could not determine the current user ID for launchctl")
  }
  return result
}

/** Writes, reloads, and removes the LaunchAgents owned by YukiOshi. */
export async function syncLaunchdSchedule(jobs: ScheduleJob[], options: LaunchdSyncOptions): Promise<void> {
  const uid = launchdUid(options.uid)
  const runner = options.launchctl ?? runLaunchctl
  const directory = launchdDirectory(options.home)
  const enabled = new Map<string, ScheduleJob>()
  for (const job of jobs) {
    assertSafeJobId(job.id)
    if (!job.enabled) continue
    if (enabled.has(job.id)) throw new Error(`Duplicate scheduled job ID for launchd: ${job.id}`)
    enabled.set(job.id, job)
  }

  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await managedLaunchAgents(directory)
  const existingById = new Map(existing.map((agent) => [agent.id, agent]))
  const touched = new Set<string>()
  const bootstrapped: string[] = []

  try {
    for (const agent of existing) {
      if (enabled.has(agent.id)) continue
      await bootoutLaunchAgent(runner, uid, agent.plistPath)
      await fs.rm(agent.plistPath, { force: true })
    }

    for (const job of enabled.values()) {
      const plistPath = launchdPlistPath(options.home, job.id)
      if (existingById.has(job.id)) {
        touched.add(plistPath)
        await bootoutLaunchAgent(runner, uid, plistPath)
      }
      const plist = launchdPlist(job, options.binary, options.home, options.pathEnv, options.env)
      touched.add(plistPath)
      await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 })
      await fs.chmod(plistPath, 0o600)
      await runner(launchctlBootstrapArgs(uid, plistPath))
      bootstrapped.push(plistPath)
    }
  } catch (error) {
    await Promise.all(
      bootstrapped.map(async (plistPath) => {
        try {
          await runner(launchctlBootoutArgs(uid, plistPath))
        } catch {}
      }),
    )
    await Promise.all([...touched].map((plistPath) => fs.rm(plistPath, { force: true }).catch(() => {})))
    throw error
  }
}
