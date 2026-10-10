import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { BackgroundShell } from "@/background/shell"
import { TasksCommand } from "@/cli/cmd/tasks"

afterEach(() => BackgroundShell.reset())

function write(sessionID: string, jobs: object[]) {
  fs.mkdirSync(BackgroundShell.stateDir(), { recursive: true })
  fs.writeFileSync(path.join(BackgroundShell.stateDir(), `${sessionID}.json`), JSON.stringify({ sessionID, jobs }))
}

const row = (id: string, state: string, owner: number) => ({
  id,
  sessionID: "ses_tasks",
  command: "sleep 100",
  cwd: "/tmp",
  state,
  ageMs: 1000,
  last: ["x"],
  startedAt: Date.now() - 1000,
  owner,
})

describe("yukioshi tasks", () => {
  test("is a command named tasks with --session and --format", () => {
    expect(TasksCommand.command).toBe("tasks")
    expect(String(TasksCommand.describe)).toContain("read-only")
  })

  test("shows a job of another live process as running", () => {
    write("ses_tasks", [row("job_a", "running", process.ppid)])
    expect(BackgroundShell.readStored("ses_tasks")[0]?.lost).toBeUndefined()
  })

  test("marks a running job lost when its owner is gone", () => {
    write("ses_tasks", [row("job_b", "running", 2 ** 22 + 12345)])
    expect(BackgroundShell.readStored("ses_tasks")[0]?.lost).toBe(true)
  })

  test("keeps a finished job as it was", () => {
    write("ses_tasks", [row("job_c", "exited", 2 ** 22 + 12345)])
    const [job] = BackgroundShell.readStored("ses_tasks")
    expect(job?.state).toBe("exited")
    expect(job?.lost).toBeUndefined()
  })

  test("an unknown session has no jobs", () => {
    expect(BackgroundShell.readStored("ses_none")).toEqual([])
  })
})
