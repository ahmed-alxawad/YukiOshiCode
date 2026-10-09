// Storage and concurrency management for scheduled tasks.
// Persists jobs in <state>/schedule/jobs.json, run logs in <state>/schedule/<id>/<timestamp>.log,
// and enforces single-instance job execution via file locks.

import path from "path"
import fs from "fs/promises"
import { existsSync, readFileSync } from "fs"
import { Global } from "@yukioshi/core/global"

export interface ScheduleJob {
  id: string
  name: string
  cron: string
  prompt: string
  directory: string
  model?: string
  agent?: string
  auto: boolean
  /** Run in permission mode review: a small model decides each action that is not low-risk. */
  review?: boolean
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastResult?: string
}

export function getScheduleDir(): string {
  return path.join(Global.Path.state, "schedule")
}

export function getJobsPath(): string {
  return path.join(getScheduleDir(), "jobs.json")
}

export function assertSafeJobId(jobId: string): void {
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    throw new Error(
      `Invalid job ID: "${jobId}". Job IDs must contain only alphanumeric characters, underscores, and hyphens.`,
    )
  }
}

export function getJobLogsDir(jobId: string): string {
  assertSafeJobId(jobId)
  const dir = path.join(getScheduleDir(), jobId)
  const resolved = path.resolve(dir)
  const base = path.resolve(getScheduleDir())
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Job ID "${jobId}" resolves outside schedule directory`)
  }
  return dir
}

export async function loadJobs(): Promise<ScheduleJob[]> {
  const filePath = getJobsPath()
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed as ScheduleJob[]
    }
    return []
  } catch (err: any) {
    if (err.code === "ENOENT") return []
    throw err
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

/** rename() that retries briefly: on Windows it fails while another process has the target open. */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = (a, b) => fs.rename(a, b),
  delayMs = 50,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err: any) {
      if (attempt >= 5 || !RENAME_RETRY_CODES.has(err?.code)) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export async function saveJobs(jobs: ScheduleJob[]): Promise<void> {
  const scheduleDir = getScheduleDir()
  await fs.mkdir(scheduleDir, { recursive: true })
  const targetPath = getJobsPath()
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(jobs, null, 2), { encoding: "utf8", mode: 0o600 })
  await renameWithRetry(tmpPath, targetPath)
}

export async function findJob(id: string): Promise<ScheduleJob | undefined> {
  const jobs = await loadJobs()
  const exact = jobs.find((j) => j.id === id)
  if (exact) return exact

  // Also support unique prefix match (at least 6 characters)
  if (id.length >= 6) {
    const matches = jobs.filter((j) => j.id.startsWith(id))
    if (matches.length === 1) return matches[0]
  }

  return undefined
}

export async function writeRunLog(jobId: string, content: string, time: number = Date.now()): Promise<string> {
  assertSafeJobId(jobId)
  const dir = getJobLogsDir(jobId)
  try {
    const st = await fs.lstat(dir)
    if (st.isSymbolicLink()) {
      throw new Error(`Log directory is a symbolic link: ${dir}`)
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err
  }
  await fs.mkdir(dir, { recursive: true })
  const filename = `${time}.log`
  const logPath = path.join(dir, filename)

  try {
    const handle = await fs.open(logPath, "wx")
    await handle.writeFile(content, "utf8")
    await handle.close()
  } catch (err: any) {
    if (err.code === "EEXIST") {
      const st = await fs.lstat(logPath)
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to write log to symlink: ${logPath}`)
      }
      await fs.writeFile(logPath, content, "utf8")
    } else {
      throw err
    }
  }

  await pruneLogs(jobId, 50)
  return logPath
}

export interface LogEntry {
  filename: string
  path: string
  time: number
  size: number
}

export async function getRunLogs(jobId: string): Promise<LogEntry[]> {
  const dir = getJobLogsDir(jobId)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const logs: LogEntry[] = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".log")) {
        const fullPath = path.join(dir, entry.name)
        const stat = await fs.stat(fullPath)
        const timePart = entry.name.replace(/\.log$/, "")
        const parsedTime = Number.parseInt(timePart, 10)
        logs.push({
          filename: entry.name,
          path: fullPath,
          time: Number.isNaN(parsedTime) ? stat.mtimeMs : parsedTime,
          size: stat.size,
        })
      }
    }
    // Sort newest first
    logs.sort((a, b) => b.time - a.time)
    return logs
  } catch (err: any) {
    if (err.code === "ENOENT") return []
    throw err
  }
}

export async function pruneLogs(jobId: string, maxLogs: number = 50): Promise<void> {
  const logs = await getRunLogs(jobId)
  if (logs.length <= maxLogs) return

  const toDelete = logs.slice(maxLogs)
  for (const log of toDelete) {
    try {
      await fs.unlink(log.path)
    } catch {
      // Ignore cleanup error
    }
  }
}

const LOCK_MIN_STALE_MS = 24 * 60 * 60 * 1000

/** Start time of a process (Linux: /proc/<pid>/stat field 22), or undefined when it cannot be determined. */
export function processStartTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The command name (field 2) may contain spaces and parentheses, so split after the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return fields[19]
  } catch {
    return undefined
  }
}

export function isStaleLock(lock: { pid: number; time?: unknown; start?: unknown }, timeoutMs = 0): boolean {
  const limit = Math.max(LOCK_MIN_STALE_MS, timeoutMs)
  if (typeof lock.time === "number" && Date.now() - lock.time > limit) return true
  try {
    process.kill(lock.pid, 0)
  } catch (e: any) {
    // ESRCH means the process doesn't exist; EPERM means it exists but belongs to someone else
    if (e.code === "ESRCH") return true
  }
  if (typeof lock.start === "string") {
    const current = processStartTime(lock.pid)
    if (current !== undefined && current !== lock.start) return true
  }
  return false
}

export interface JobLock {
  release: () => Promise<void>
}

/**
 * Attempts to acquire an exclusive lock file for the given job.
 * Returns null if another process holds the lock. A lock is stale when its process is gone, when the pid now
 * belongs to a different process (start time differs), or when it is older than max(24h, job timeout).
 */
export async function acquireJobLock(jobId: string, timeoutMs: number = 0): Promise<JobLock | null> {
  assertSafeJobId(jobId)
  const dir = getJobLogsDir(jobId)
  try {
    const st = await fs.lstat(dir)
    if (st.isSymbolicLink()) {
      throw new Error(`Log directory is a symbolic link: ${dir}`)
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err
  }
  await fs.mkdir(dir, { recursive: true })
  const lockFile = path.join(dir, "lock")

  // Check if lock file is a planted symlink
  try {
    const st = await fs.lstat(lockFile)
    if (st.isSymbolicLink()) {
      await fs.unlink(lockFile)
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err
  }

  // Check if lock file exists
  if (existsSync(lockFile)) {
    try {
      const data = await fs.readFile(lockFile, "utf8")
      const { pid, time, start } = JSON.parse(data)

      if (typeof pid === "number" && !isStaleLock({ pid, time, start }, timeoutMs)) {
        // Process is actively running
        return null
      }

      // Dead process, reused pid, or lock older than the staleness limit: remove it
      await fs.unlink(lockFile)
    } catch {
      // Malformed lock file or race, try unlinking
      try {
        await fs.unlink(lockFile)
      } catch {}
    }
  }

  // Create the lock exclusively. The content is written to a temporary file first and then hard-linked into
  // place: link fails with EEXIST if the lock exists, and the lock is never visible empty, which a second
  // run would otherwise read as a corrupt (stale) lock, delete, and replace.
  const tmpLock = path.join(dir, `lock.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    const handle = await fs.open(tmpLock, "wx")
    const payload = JSON.stringify({ pid: process.pid, time: Date.now(), start: processStartTime(process.pid) })
    await handle.writeFile(payload, "utf8")
    await handle.close()
    await fs.link(tmpLock, lockFile)
  } catch (err: any) {
    if (err.code === "EEXIST") {
      return null
    }
    throw err
  } finally {
    await fs.unlink(tmpLock).catch(() => {})
  }

  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      try {
        await fs.unlink(lockFile)
      } catch {
        // Ignore unlink error on release
      }
    },
  }
}
