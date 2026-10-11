// A small marker file per running turn, so another process (`yukioshi tasks --all`) can tell which sessions of this
// machine are busy right now. Session status itself lives in memory of the process that runs the turn.
// The marker holds the owner pid: a marker whose process is gone is stale and is ignored (and cleaned up on read).
import fs from "fs"
import path from "path"
import { Global } from "@yukioshi/core/global"

export interface Marker {
  readonly sessionID: string
  readonly pid: number
  readonly startedAt: number
}

export function dir() {
  return path.join(Global.Path.state, "running-turns")
}

function file(sessionID: string) {
  return path.join(dir(), `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const started = new Set<string>()

/** Marks a turn as running. Best effort: a write failure must never break a turn. */
export function mark(sessionID: string) {
  try {
    // Status is set many times per turn; keep the first start time.
    if (started.has(sessionID)) return
    started.add(sessionID)
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const marker: Marker = { sessionID, pid: process.pid, startedAt: Date.now() }
    fs.writeFileSync(file(sessionID), JSON.stringify(marker), { mode: 0o600 })
  } catch {}
}

export function clear(sessionID: string) {
  started.delete(sessionID)
  try {
    const current = JSON.parse(fs.readFileSync(file(sessionID), "utf8")) as Marker
    if (current.pid === process.pid) fs.rmSync(file(sessionID), { force: true })
  } catch {}
}

/** Markers whose owner process is still alive. Stale markers are removed. */
export function live(): Marker[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir())
  } catch {
    return []
  }
  const result: Marker[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const full = path.join(dir(), name)
    try {
      const marker = JSON.parse(fs.readFileSync(full, "utf8")) as Marker
      if (typeof marker.sessionID !== "string" || typeof marker.pid !== "number") continue
      if (alive(marker.pid)) result.push(marker)
      else fs.rmSync(full, { force: true })
    } catch {}
  }
  return result
}
