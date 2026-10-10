import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import { Audit } from "@/audit"
import { BackgroundShell } from "@/background/shell"
import { auditJob } from "@/tool/background-shell"

afterEach(() => BackgroundShell.reset())

const job = () =>
  ({
    id: "job_audit1",
    sessionID: "ses_audit",
    command: "npm run dev",
    cwd: "/tmp",
    state: "exited",
    exit: 0,
  }) as unknown as BackgroundShell.Job

const lines = () => {
  const file = Audit.file(new Date())
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
}

describe("background shell audit lines", () => {
  test("writes start, stop and exit lines when the audit log is on", async () => {
    const before = lines().length
    await auditJob("start", job(), { audit: { enabled: true } })
    await auditJob("stop", job(), { audit: { enabled: true } })
    await auditJob("exit", job(), { audit: { enabled: true } })
    const added = lines().slice(before)
    expect(added.map((l) => l.event)).toEqual(["background_shell.start", "background_shell.stop", "background_shell.exit"])
    expect(added[0].command).toBe("npm run dev")
    expect(added[2].exit).toBe(0)
  })

  test("writes nothing when the audit log is off", async () => {
    const before = lines().length
    await auditJob("start", job(), {})
    await auditJob("start", job(), { audit: { enabled: false } })
    expect(lines().length).toBe(before)
  })
})
