// Windows Task Scheduler (schtasks) mapping for scheduled tasks.
// Supports minute/hourly intervals, daily, weekly, and monthly schedules.

const DOW_MAP: Record<string, string> = {
  "0": "SUN",
  "7": "SUN",
  "1": "MON",
  "2": "TUE",
  "3": "WED",
  "4": "THU",
  "5": "FRI",
  "6": "SAT",
  sun: "SUN",
  mon: "MON",
  tue: "TUE",
  wed: "WED",
  thu: "THU",
  fri: "FRI",
  sat: "SAT",
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function parseSingleInt(s: string, min: number, max: number): number | null {
  const n = Number.parseInt(s, 10)
  if (Number.isNaN(n) || String(n) !== s.trim() || n < min || n > max) return null
  return n
}

/**
 * Maps a standard 5-field cron expression to the arguments for `schtasks.exe /Create`.
 * Refuses unsupported expressions with a clear user-facing error message.
 */
export function cronToSchtasksArgs(id: string, cron: string, binary: string): string[] {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid job ID for schtasks: "${id}"`)
  }
  if (/[\r\n"]/.test(binary)) {
    throw new Error(`Invalid binary path for schtasks: "${binary}"`)
  }
  const trimmed = cron.trim()
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${cron}": expected 5 fields, got ${fields.length}`,
    )
  }

  const [minStr, hourStr, domStr, monStr, dowStr] = fields
  const taskName = `YukiOshi\\${id}`
  const taskRun = `"${binary}" schedule run ${id}`

  // Common rejection: Month cannot be restricted in schtasks without complex xml
  if (monStr !== "*") {
    throw new Error(
      `Cron expression "${cron}" with specific month cannot be scheduled with Windows schtasks. Supported forms on Windows: minute intervals (*/N * * * *), hourly intervals (M */N * * *), daily at a time (M H * * *), weekly on specific days (M H * * DOW), or monthly on a specific day (M H DOM * *).`,
    )
  }

  // 1. Minute intervals:
  // e.g. "* * * * *" or "*/N * * * *"
  if (hourStr === "*" && domStr === "*" && monStr === "*" && dowStr === "*") {
    if (minStr === "*") {
      return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "MINUTE", "/MO", "1", "/F"]
    }
    if (minStr.startsWith("*/")) {
      const step = parseSingleInt(minStr.slice(2), 1, 59)
      if (step !== null) {
        return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "MINUTE", "/MO", String(step), "/F"]
      }
    }
  }

  // 2. Hourly intervals:
  // e.g. "M * * * *" or "M */N * * *" where M is a single minute (0-59)
  const minuteVal = parseSingleInt(minStr, 0, 59)
  if (minuteVal !== null && domStr === "*" && monStr === "*" && dowStr === "*") {
    if (hourStr === "*") {
      const startTime = `00:${pad(minuteVal)}`
      return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "HOURLY", "/MO", "1", "/ST", startTime, "/F"]
    }
    if (hourStr.startsWith("*/")) {
      const step = parseSingleInt(hourStr.slice(2), 1, 23)
      if (step !== null) {
        const startTime = `00:${pad(minuteVal)}`
        return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "HOURLY", "/MO", String(step), "/ST", startTime, "/F"]
      }
    }
  }

  // From here on, both minute and hour must be single specific numbers
  const hourVal = parseSingleInt(hourStr, 0, 23)
  if (minuteVal !== null && hourVal !== null) {
    const startTime = `${pad(hourVal)}:${pad(minuteVal)}`

    // 3. Daily at a specific time:
    // "M H * * *"
    if (domStr === "*" && dowStr === "*") {
      return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "DAILY", "/ST", startTime, "/F"]
    }

    // 4. Weekly on specific days:
    // "M H * * DOW" (DOM is "*")
    if (domStr === "*" && dowStr !== "*") {
      const days = parseSchtasksDays(dowStr)
      if (days.length > 0) {
        return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "WEEKLY", "/D", days.join(","), "/ST", startTime, "/F"]
      }
    }

    // 5. Monthly on a specific day of month:
    // "M H DOM * *" (DOW is "*")
    if (domStr !== "*" && dowStr === "*") {
      const domVal = parseSingleInt(domStr, 1, 31)
      if (domVal !== null) {
        return ["/Create", "/TN", taskName, "/TR", taskRun, "/SC", "MONTHLY", "/D", String(domVal), "/ST", startTime, "/F"]
      }
    }
  }

  throw new Error(
    `Cron expression "${cron}" cannot be scheduled with Windows schtasks. Supported forms on Windows: minute intervals (*/N * * * *), hourly intervals (M */N * * *), daily at a time (M H * * *), weekly on specific days (M H * * DOW), or monthly on a specific day (M H DOM * *).`,
  )
}

function parseSchtasksDays(dowStr: string): string[] {
  const parts = dowStr.split(",")
  const days = new Set<string>()

  for (const part of parts) {
    const trimmed = part.trim().toLowerCase()
    if (!trimmed) return []

    // Range like 1-5 or mon-fri
    const dash = trimmed.indexOf("-")
    if (dash !== -1) {
      const startStr = trimmed.slice(0, dash)
      const endStr = trimmed.slice(dash + 1)
      const startDay = DOW_MAP[startStr]
      const endDay = DOW_MAP[endStr]
      if (!startDay || !endDay) return []

      const dayOrder = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
      const startIdx = dayOrder.indexOf(startDay)
      const endIdx = dayOrder.indexOf(endDay)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return []

      for (let i = startIdx; i <= endIdx; i++) {
        days.add(dayOrder[i])
      }
      continue
    }

    const day = DOW_MAP[trimmed]
    if (!day) return []
    days.add(day)
  }

  return Array.from(days)
}

export function schtasksDeleteArgs(id: string): string[] {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid job ID for schtasks delete: "${id}"`)
  }
  return ["/Delete", "/TN", `YukiOshi\\${id}`, "/F"]
}
