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

export type LaunchdSchedule = { type: "calendar"; intervals: LaunchdCalendarInterval[] }

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

/** Maps supported five-field cron syntax to exact launchd calendar scheduling keys. */
export function cronToLaunchdSchedule(cronExpression: string): LaunchdSchedule {
  const cron = validateCron(cronExpression)
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

async function assertManagedPlistNotSymlink(plistPath: string): Promise<void> {
  try {
    if ((await fs.lstat(plistPath)).isSymbolicLink()) {
      throw new Error(`Refusing to manage LaunchAgent plist symbolic link: ${plistPath}`)
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return
    throw error
  }
}

async function writeManagedPlist(plistPath: string, plist: string): Promise<void> {
  await assertManagedPlistNotSymlink(plistPath)
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 })
  await assertManagedPlistNotSymlink(plistPath)
  await fs.chmod(plistPath, 0o600)
}

async function removeManagedPlist(plistPath: string): Promise<void> {
  await assertManagedPlistNotSymlink(plistPath)
  await fs.rm(plistPath, { force: true })
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

interface PlannedLaunchAgent {
  job: ScheduleJob
  plistPath: string
  plist: string
}

interface LaunchAgentBackup {
  plistPath: string
  backupPath: string
}

function launchdBackupPath(plistPath: string): string {
  return `${plistPath}.yukioshi-backup`
}

async function createLaunchAgentBackup(plistPath: string): Promise<LaunchAgentBackup> {
  await assertManagedPlistNotSymlink(plistPath)
  const contents = await fs.readFile(plistPath, "utf8")
  const backupPath = launchdBackupPath(plistPath)
  try {
    await fs.writeFile(backupPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await assertManagedPlistNotSymlink(backupPath)
    await fs.chmod(backupPath, 0o600)
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing to update LaunchAgent with an existing backup: ${backupPath}`)
    }
    throw error
  }
  return { plistPath, backupPath }
}

async function discardLaunchAgentBackup(backup: LaunchAgentBackup): Promise<void> {
  try {
    await fs.rm(backup.backupPath, { force: true })
  } catch {
    // The active or restored agent is safe. Keep an undeletable backup for manual recovery.
  }
}

function recoveryFailure(plistPath: string, backupPath: string, updateError: unknown, recoveryError: unknown): Error {
  return new Error(
    `Failed to update LaunchAgent ${plistPath}: ${String(updateError)}. ` +
      `Recovery failed: ${String(recoveryError)}. Original plist backup preserved at ${backupPath}`,
  )
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
    if (path.dirname(plistPath) === directory) {
      await assertManagedPlistNotSymlink(plistPath)
      agents.push({ id, plistPath })
    }
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

async function cleanupFailedNewLaunchAgent(runner: LaunchctlRunner, uid: number, plistPath: string): Promise<void> {
  try {
    await assertManagedPlistNotSymlink(plistPath)
    await bootoutLaunchAgent(runner, uid, plistPath)
  } catch {
    // A failed bootstrap can leave the service absent, partially loaded, or already removed.
  }
  try {
    await removeManagedPlist(plistPath)
  } catch {
    // Never remove a plist that has become a symlink while handling a failed update.
  }
}

async function installLaunchAgent(runner: LaunchctlRunner, uid: number, agent: PlannedLaunchAgent): Promise<void> {
  await assertManagedPlistNotSymlink(agent.plistPath)
  try {
    await writeManagedPlist(agent.plistPath, agent.plist)
    await runner(launchctlBootstrapArgs(uid, agent.plistPath))
  } catch (error) {
    await cleanupFailedNewLaunchAgent(runner, uid, agent.plistPath)
    throw error
  }
}

async function restoreLaunchAgentBackup(
  runner: LaunchctlRunner,
  uid: number,
  backup: LaunchAgentBackup,
): Promise<void> {
  await assertManagedPlistNotSymlink(backup.plistPath)
  await bootoutLaunchAgent(runner, uid, backup.plistPath)
  await removeManagedPlist(backup.plistPath)
  await assertManagedPlistNotSymlink(backup.backupPath)
  const originalPlist = await fs.readFile(backup.backupPath, "utf8")
  await writeManagedPlist(backup.plistPath, originalPlist)
  await runner(launchctlBootstrapArgs(uid, backup.plistPath))
}

async function updateLaunchAgent(runner: LaunchctlRunner, uid: number, agent: PlannedLaunchAgent): Promise<void> {
  const backup = await createLaunchAgentBackup(agent.plistPath)
  try {
    await bootoutLaunchAgent(runner, uid, agent.plistPath)
    await writeManagedPlist(agent.plistPath, agent.plist)
    await runner(launchctlBootstrapArgs(uid, agent.plistPath))
  } catch (updateError) {
    try {
      await restoreLaunchAgentBackup(runner, uid, backup)
    } catch (recoveryError) {
      throw recoveryFailure(agent.plistPath, backup.backupPath, updateError, recoveryError)
    }
    await discardLaunchAgentBackup(backup)
    throw updateError
  }
  await discardLaunchAgentBackup(backup)
}

async function removeLaunchAgent(runner: LaunchctlRunner, uid: number, plistPath: string): Promise<void> {
  await assertManagedPlistNotSymlink(plistPath)
  await bootoutLaunchAgent(runner, uid, plistPath)
  await removeManagedPlist(plistPath)
}

/** Writes, reloads, and removes the LaunchAgents owned by YukiOshi. */
export async function syncLaunchdSchedule(jobs: ScheduleJob[], options: LaunchdSyncOptions): Promise<void> {
  const uid = launchdUid(options.uid)
  const runner = options.launchctl ?? runLaunchctl
  const directory = launchdDirectory(options.home)
  const enabled = new Map<string, PlannedLaunchAgent>()
  for (const job of jobs) {
    assertSafeJobId(job.id)
    if (!job.enabled) continue
    if (enabled.has(job.id)) throw new Error(`Duplicate scheduled job ID for launchd: ${job.id}`)
    const plistPath = launchdPlistPath(options.home, job.id)
    enabled.set(job.id, {
      job,
      plistPath,
      // Render every plist before changing any LaunchAgent so cron fallback cannot leave a partial sync.
      plist: launchdPlist(job, options.binary, options.home, options.pathEnv, options.env),
    })
  }

  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await managedLaunchAgents(directory)
  const existingById = new Map(existing.map((agent) => [agent.id, agent]))
  const newlyInstalled: PlannedLaunchAgent[] = []

  try {
    for (const agent of enabled.values()) {
      if (existingById.has(agent.job.id)) {
        await updateLaunchAgent(runner, uid, agent)
      } else {
        await installLaunchAgent(runner, uid, agent)
        newlyInstalled.push(agent)
      }
    }

    for (const agent of existing) {
      if (enabled.has(agent.id)) continue
      await removeLaunchAgent(runner, uid, agent.plistPath)
    }
  } catch (error) {
    await Promise.all(newlyInstalled.map((agent) => cleanupFailedNewLaunchAgent(runner, uid, agent.plistPath)))
    throw error
  }
}
