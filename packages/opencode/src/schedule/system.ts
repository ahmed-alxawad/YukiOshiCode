// System scheduler integration (crontab on Linux/macOS, schtasks on Windows).
// Manages the designated "# BEGIN yukioshi schedule" ... "# END yukioshi schedule" block.

import path from "path"
import os from "os"
import fs from "fs/promises"
import { existsSync } from "fs"
import type { ScheduleJob } from "./store"
import { cronToSchtasksArgs, schtasksDeleteArgs } from "./windows"

export const CRON_BLOCK_START = "# BEGIN yukioshi schedule"
export const CRON_BLOCK_END = "# END yukioshi schedule"

export function getYukioshiBinary(): string {
  if (process.env.YUKIOSHI_BINARY_PATH) {
    return path.resolve(process.env.YUKIOSHI_BINARY_PATH)
  }
  if (process.execPath.includes("yukioshi")) {
    return path.resolve(process.execPath)
  }
  if (process.argv[1]) {
    const devBin = path.resolve(path.dirname(process.argv[1]), "../bin/yukioshi-dev")
    if (existsSync(devBin)) {
      return devBin
    }
    const relBin = path.resolve(path.dirname(process.argv[1]), "../bin/yukioshi")
    if (existsSync(relBin)) {
      return relBin
    }
    return path.resolve(process.argv[1])
  }
  return process.execPath
}

export function buildCronLine(job: ScheduleJob, binaryPath: string, home: string, pathEnv: string): string {
  return `${job.cron} HOME="${home}" PATH="${pathEnv}" "${binaryPath}" schedule run ${job.id}`
}

/**
 * Pure function to insert, update, or remove the yukioshi schedule block in a crontab string.
 * Preserves all other lines, comments, and empty lines exactly.
 */
export function updateCrontabBlock(
  existingCrontab: string,
  jobs: ScheduleJob[],
  binaryPath: string,
  home: string,
  pathEnv: string,
): string {
  const enabledJobs = jobs.filter((j) => j.enabled)
  const blockRegex = /(?:^|\n)# BEGIN yukioshi schedule\r?\n[\s\S]*?\r?\n# END yukioshi schedule(?:\r?\n|$)/

  if (enabledJobs.length === 0) {
    // Remove block if present
    if (blockRegex.test(existingCrontab)) {
      const removed = existingCrontab.replace(blockRegex, "\n")
      // Normalize multiple consecutive blank lines at the replacement site
      const cleaned = removed.replace(/\n{3,}/g, "\n\n").trimEnd()
      return cleaned.length > 0 ? `${cleaned}\n` : ""
    }
    return existingCrontab
  }

  const lines = enabledJobs.map((j) => buildCronLine(j, binaryPath, home, pathEnv))
  const newBlock = `${CRON_BLOCK_START}\n${lines.join("\n")}\n${CRON_BLOCK_END}`

  if (blockRegex.test(existingCrontab)) {
    // Replace existing block
    return existingCrontab.replace(blockRegex, (match) => {
      const leadingNewline = match.startsWith("\n") ? "\n" : ""
      return `${leadingNewline}${newBlock}\n`
    })
  }

  // Append new block
  const trimmed = existingCrontab.trimEnd()
  if (trimmed.length > 0) {
    return `${trimmed}\n\n${newBlock}\n`
  }
  return `${newBlock}\n`
}

export async function readCrontab(): Promise<string> {
  // Test hook: read from fake crontab file if configured
  if (process.env.YUKIOSHI_CRONTAB) {
    if (existsSync(process.env.YUKIOSHI_CRONTAB)) {
      return await fs.readFile(process.env.YUKIOSHI_CRONTAB, "utf8")
    }
    return ""
  }

  try {
    const proc = Bun.spawn(["crontab", "-l"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode === 0) {
      return stdout
    }

    const errText = stderr.trim()
    // "no crontab for <user>" is a normal empty state
    if (errText.includes("no crontab for")) {
      return ""
    }

    if (errText.includes("not allowed to access to (crontab) because of pam configuration")) {
      throw new Error(
        `crontab is not accessible in this environment (PAM restricted): ${errText}. Run yukioshi outside the container/sandbox or verify crontab permissions.`,
      )
    }

    throw new Error(`Failed to read crontab (exit ${exitCode}): ${errText}`)
  } catch (err: any) {
    if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
      throw new Error("crontab command not found; install cron to use scheduled tasks")
    }
    throw err
  }
}

export async function writeCrontab(content: string): Promise<void> {
  // Test hook: write to fake crontab file if configured
  if (process.env.YUKIOSHI_CRONTAB) {
    const parentDir = path.dirname(process.env.YUKIOSHI_CRONTAB)
    await fs.mkdir(parentDir, { recursive: true })
    await fs.writeFile(process.env.YUKIOSHI_CRONTAB, content, "utf8")
    return
  }

  try {
    if (!content.trim()) {
      // Empty content: remove crontab cleanly
      const proc = Bun.spawn(["crontab", "-r"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      return
    }

    const proc = Bun.spawn(["crontab", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(content)
    proc.stdin.end()

    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      throw new Error(`Failed to update crontab (exit ${exitCode}): ${stderr.trim()}`)
    }
  } catch (err: any) {
    if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
      throw new Error("crontab command not found; install cron to use scheduled tasks")
    }
    throw err
  }
}

/**
 * Synchronizes the list of configured jobs with the host system's scheduler:
 * - On Linux/macOS: updates the "# BEGIN yukioshi schedule" block in crontab.
 * - On Windows: creates or deletes tasks in Task Scheduler via schtasks.exe.
 */
export async function syncSystemSchedule(jobs: ScheduleJob[]): Promise<void> {
  if (process.platform === "win32") {
    const binary = getYukioshiBinary()
    for (const job of jobs) {
      if (job.enabled) {
        const args = cronToSchtasksArgs(job.id, job.cron, binary)
        const proc = Bun.spawn(["schtasks", ...args], { stdout: "pipe", stderr: "pipe" })
        const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        if (exitCode !== 0) {
          throw new Error(`schtasks failed for job ${job.id}: ${stderr.trim()}`)
        }
      } else {
        const args = schtasksDeleteArgs(job.id)
        const proc = Bun.spawn(["schtasks", ...args], { stdout: "pipe", stderr: "pipe" })
        await proc.exited
      }
    }
    return
  }

  // Linux & macOS
  const existing = await readCrontab()
  const binary = getYukioshiBinary()
  const home = process.env.YUKIOSHI_TEST_HOME ?? process.env.HOME ?? os.homedir()
  const pathEnv = process.env.PATH ?? ""
  const updated = updateCrontabBlock(existing, jobs, binary, home, pathEnv)
  await writeCrontab(updated)
}
