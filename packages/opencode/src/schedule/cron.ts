// Cron expression parser, validator, and next-run calculator for standard 5-field cron syntax.
// Supported fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-7).

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export interface ParsedCron {
  raw: string
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseNumber(token: string, nameMap?: Record<string, number>): number {
  const lower = token.toLowerCase()
  if (nameMap && Object.hasOwn(nameMap, lower)) {
    return nameMap[lower]
  }
  const val = Number.parseInt(token, 10)
  if (Number.isNaN(val) || String(val) !== token.trim()) {
    throw new Error(`Invalid numeric value: "${token}"`)
  }
  return val
}

function parseField(
  fieldName: string,
  fieldStr: string,
  min: number,
  max: number,
  nameMap?: Record<string, number>,
): Set<number> {
  const result = new Set<number>()
  const parts = fieldStr.split(",")

  if (!fieldStr || parts.length === 0) {
    throw new Error(`Empty value for cron ${fieldName}`)
  }

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) {
      throw new Error(`Empty token in cron ${fieldName}: "${fieldStr}"`)
    }

    if (trimmed === "*") {
      for (let i = min; i <= max; i++) result.add(i)
      continue
    }

    if (trimmed.startsWith("*/")) {
      const stepStr = trimmed.slice(2)
      const step = Number.parseInt(stepStr, 10)
      if (Number.isNaN(step) || step <= 0 || String(step) !== stepStr) {
        throw new Error(`Invalid step "${stepStr}" in cron ${fieldName}`)
      }
      for (let i = min; i <= max; i += step) {
        result.add(i)
      }
      continue
    }

    const slashIdx = trimmed.indexOf("/")
    let rangePart = trimmed
    let step = 1
    if (slashIdx !== -1) {
      rangePart = trimmed.slice(0, slashIdx)
      const stepStr = trimmed.slice(slashIdx + 1)
      step = Number.parseInt(stepStr, 10)
      if (Number.isNaN(step) || step <= 0 || String(step) !== stepStr) {
        throw new Error(`Invalid step "${stepStr}" in cron ${fieldName}`)
      }
    }

    const dashIdx = rangePart.indexOf("-")
    if (dashIdx !== -1) {
      const startStr = rangePart.slice(0, dashIdx)
      const endStr = rangePart.slice(dashIdx + 1)
      const start = parseNumber(startStr, nameMap)
      const end = parseNumber(endStr, nameMap)

      if (start < min || start > max) {
        throw new Error(`Value ${start} out of range [${min}, ${max}] in cron ${fieldName}`)
      }
      if (end < min || end > max) {
        throw new Error(`Value ${end} out of range [${min}, ${max}] in cron ${fieldName}`)
      }
      if (start > end) {
        throw new Error(`Range start ${start} exceeds end ${end} in cron ${fieldName}`)
      }

      for (let i = start; i <= end; i += step) {
        result.add(i)
      }
      continue
    }

    const single = parseNumber(rangePart, nameMap)
    if (single < min || single > max) {
      throw new Error(`Value ${single} out of range [${min}, ${max}] in cron ${fieldName}`)
    }
    if (slashIdx !== -1) {
      // `5/15` means "from 5 to the end of the field, every 15" (Vixie cron).
      for (let i = single; i <= max; i += step) result.add(i)
      continue
    }
    result.add(single)
  }

  return result
}

/**
 * Validates and parses a standard 5-field cron expression.
 * Throws a descriptive Error if the expression is invalid.
 */
export function validateCron(expression: string): ParsedCron {
  if (/[\r\n]/.test(expression)) {
    throw new Error(`Invalid cron expression "${expression}": contains newline`)
  }
  const trimmed = expression.trim()
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    )
  }

  const [minStr, hourStr, domStr, monStr, dowStr] = fields

  try {
    const minutes = parseField("minute", minStr, 0, 59)
    const hours = parseField("hour", hourStr, 0, 23)
    const daysOfMonth = parseField("day-of-month", domStr, 1, 31)
    const months = parseField("month", monStr, 1, 12, MONTH_NAMES)
    const rawDow = parseField("day-of-week", dowStr, 0, 7, DOW_NAMES)

    // Normalize day-of-week: 7 is Sunday (0)
    const daysOfWeek = new Set<number>()
    for (const d of rawDow) {
      daysOfWeek.add(d === 7 ? 0 : d)
    }

    return {
      raw: trimmed,
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      domRestricted: domStr !== "*",
      dowRestricted: dowStr !== "*",
    }
  } catch (err: any) {
    throw new Error(`Invalid cron expression "${expression}": ${err.message}`)
  }
}

/**
 * Calculates the next Date when the given cron expression will trigger,
 * starting from `fromDate` (exclusive of the current minute if seconds > 0).
 */
export function nextRun(cron: string | ParsedCron, fromDate: Date = new Date()): Date {
  const parsed = typeof cron === "string" ? validateCron(cron) : cron

  // Start checking from the next whole minute
  const d = new Date(fromDate.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)

  // Max search boundary: 5 years into the future
  const deadline = fromDate.getTime() + 5 * 366 * 24 * 60 * 60 * 1000

  while (d.getTime() < deadline) {
    // 1. Check Month (1-12)
    const month = d.getMonth() + 1
    if (!parsed.months.has(month)) {
      // Advance to 1st of next month at 00:00
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }

    // 2. Check Day (Day of Month & Day of Week)
    const dom = d.getDate()
    const dow = d.getDay() // 0 = Sunday

    const domMatches = parsed.daysOfMonth.has(dom)
    const dowMatches = parsed.daysOfWeek.has(dow)

    let dayMatches = false
    if (parsed.domRestricted && parsed.dowRestricted) {
      // If both are restricted in cron, trigger if either matches (POSIX / Vixie standard)
      dayMatches = domMatches || dowMatches
    } else if (parsed.domRestricted) {
      dayMatches = domMatches
    } else if (parsed.dowRestricted) {
      dayMatches = dowMatches
    } else {
      dayMatches = true
    }

    if (!dayMatches) {
      // Advance to next day at 00:00
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }

    // 3. Check Hour (0-23)
    const hour = d.getHours()
    if (!parsed.hours.has(hour)) {
      // Advance to next hour at minute 00
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }

    // 4. Check Minute (0-59)
    const minute = d.getMinutes()
    if (!parsed.minutes.has(minute)) {
      d.setMinutes(d.getMinutes() + 1)
      continue
    }

    // All matched
    return d
  }

  throw new Error(`No matching run time found within 5 years for cron "${parsed.raw}"`)
}
