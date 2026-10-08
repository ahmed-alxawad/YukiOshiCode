import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { file, sanitizeField, writeEntry } from "../../src/audit"

describe("audit log security", () => {
  test("sanitizes secrets and bounds length in any field", () => {
    const token = "ghp_" + "Ab1".repeat(12)
    const longString = "x".repeat(1000)

    const raw = {
      event: "tool",
      customSecret: `Bearer ${token}`,
      veryLongValue: longString,
      nested: {
        deepSecret: `password: secret_password_123`,
        deepLong: "y".repeat(800),
      },
      list: [`export TOKEN=${token}`, "z".repeat(900)],
    }

    const sanitized = sanitizeField(raw) as Record<string, unknown>
    const json = JSON.stringify(sanitized)

    expect(json).not.toContain(token)
    expect(json).toContain("[REDACTED:")
    expect(String(sanitized.veryLongValue)).toHaveLength(501)
    expect(String(sanitized.veryLongValue).endsWith("…")).toBe(true)
    expect(String((sanitized.nested as Record<string, unknown>).deepLong)).toHaveLength(501)
    expect(String((sanitized.list as unknown[])[1])).toHaveLength(501)
  })

  test("writeEntry enforces 0700 on directory and 0600 on audit file", async () => {
    const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "yk-audit-test-"))
    const auditDir = path.join(tempState, "audit")
    // Pre-create directory with looser permissions
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o777 })

    const now = new Date()
    const target = file(now, auditDir)

    // Also pre-create target file with looser permissions
    fs.writeFileSync(target, "", { mode: 0o666 })

    const token = "ghp_" + "SecretToken12345678901234567890"
    const secretDir = `/home/user/${token}`

    await writeEntry(
      {
        event: "trigger",
        secret: token,
        huge: "a".repeat(2000),
      },
      secretDir,
      auditDir,
    )

    const dirStat = fs.statSync(auditDir)
    const fileStat = fs.statSync(target)

    // Check POSIX permissions
    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)

    const content = fs.readFileSync(target, "utf8")
    expect(content).not.toContain(token)
    expect(content).toContain("[REDACTED:")
    expect(content).toContain("…")
  })
})
