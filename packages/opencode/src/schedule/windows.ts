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

/** Task Scheduler refuses a /TR command longer than 261 characters. */
export const MAX_TASK_RUN = 261

/**
 * The command a task runs. Task Scheduler starts tasks with a bare environment, so carried settings (XDG_*,
 * YUKIOSHI_CONFIG*) are set through cmd.exe first, the way the cron line carries them.
 */
export function taskRunCommand(id: string, binary: string, env: Record<string, string> = {}): string {
  const run = `"${binary}" schedule run ${id}`
  const entries = Object.entries(env)
  if (entries.length === 0) return run
  const sets = entries.map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name for schtasks: "${name}"`)
    if (/[\r\n"%]/.test(value)) throw new Error(`Cannot carry ${name} to Windows Task Scheduler: its value contains a quote, percent sign or line break.`)
    return `set "${name}=${value}"`
  })
  return `cmd.exe /d /s /c "${sets.join(" && ")} && ${run}"`
}

/**
 * Maps a standard 5-field cron expression to the arguments for `schtasks.exe /Create`.
 * Refuses unsupported expressions with a clear user-facing error message.
 */
export function cronToSchtasksArgs(
  id: string,
  cron: string,
  binary: string,
  env: Record<string, string> = {},
): string[] {
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
  const taskRun = taskRunCommand(id, binary, env)
  if (taskRun.length > MAX_TASK_RUN) {
    throw new Error(
      `The command for scheduled job ${id} is ${taskRun.length} characters long, but Windows Task Scheduler accepts at most ${MAX_TASK_RUN}. Install YukiOshi in a shorter folder or unset XDG_*/YUKIOSHI_CONFIG* variables with long values.`,
    )
  }

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

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const DAY_ELEMENT: Record<string, string> = {
  SUN: "Sunday",
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
}

/**
 * Task definition XML for `schtasks /Create /XML`. The command line flags cannot express power settings, so
 * the task is created from XML: it still starts on battery power and runs once a missed start is possible.
 * The schedule comes from the same mapping as the flags, so both accept exactly the same cron expressions.
 */
export function cronToTaskXml(id: string, cron: string, binary: string, env: Record<string, string> = {}): string {
  const args = cronToSchtasksArgs(id, cron, binary, env)
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }
  const sc = flag("/SC")
  const mo = flag("/MO")
  const st = flag("/ST") ?? "00:00"
  const d = flag("/D")
  const start = `2000-01-01T${st}:00`
  let trigger: string
  if (sc === "MINUTE") {
    trigger = `<TimeTrigger><Repetition><Interval>PT${mo}M</Interval></Repetition><StartBoundary>2000-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>`
  } else if (sc === "HOURLY") {
    trigger = `<TimeTrigger><Repetition><Interval>PT${mo}H</Interval></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`
  } else if (sc === "DAILY") {
    trigger = `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`
  } else if (sc === "WEEKLY") {
    const days = (d ?? "").split(",").map((x) => `<${DAY_ELEMENT[x]} />`).join("")
    trigger = `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek>${days}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`
  } else if (sc === "MONTHLY") {
    const months = Object.values(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]).map((m) => `<${m} />`).join("")
    trigger = `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>${d}</Day></DaysOfMonth><Months>${months}</Months></ScheduleByMonth></CalendarTrigger>`
  } else {
    throw new Error(`Unsupported schedule type for Windows task: ${sc}`)
  }
  const [command, ...rest] = (() => {
    const run = args[args.indexOf("/TR") + 1]
    if (run.startsWith("cmd.exe ")) return ["cmd.exe", run.slice("cmd.exe ".length)]
    return [binary, `schedule run ${id}`]
  })()
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>YukiOshi scheduled job ${xmlEscape(id)}</Description></RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(command)}</Command><Arguments>${xmlEscape(rest.join(" "))}</Arguments></Exec></Actions>
</Task>
`
}
