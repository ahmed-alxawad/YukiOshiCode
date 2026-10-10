import { describe, expect, it } from "bun:test"
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { planSpawn, quoteCmdArg } from "../../src/delegate/spawn"
import { cronToTaskXml } from "../../src/schedule/windows"

describe("Windows platform verification: .cmd shim launch and schtasks XML", () => {
  it("quoteCmdArg escapes cmd metacharacters and handles spaces, quotes, &, %, ^", () => {
    // Basic quoting & double-escaping for cmd arguments
    const q1 = quoteCmdArg("arg with spaces", true)
    expect(q1.startsWith('^^^"')).toBe(true)
    expect(q1.endsWith('^^^"')).toBe(true)

    // Ampersand is caret-escaped so cmd.exe never treats it as command separator
    const q2 = quoteCmdArg("safe & echo INJECTED", true)
    expect(q2).not.toMatch(/(^|[^^])&/)

    // Caret is escaped
    const q3 = quoteCmdArg("test^caret", true)
    expect(q3).toContain("^^")

    // Percent is escaped
    const q4 = quoteCmdArg("%PATH%", true)
    expect(q4).toContain("^^^%")

    // Quotes are escaped
    const q5 = quoteCmdArg('say "hello"', true)
    expect(q5).toContain('\\^^^"')

    // Line breaks and NUL are strictly rejected
    expect(() => quoteCmdArg("line1\nline2")).toThrow(/line breaks/i)
    expect(() => quoteCmdArg("line1\rline2")).toThrow(/line breaks/i)
    expect(() => quoteCmdArg("null\0byte")).toThrow(/line breaks|NUL/i)
  })

  it("planSpawn creates safe cmd.exe invocation for .cmd scripts", () => {
    const mockOptions = {
      platform: "win32" as const,
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe", Path: "C:\\test" },
      cwd: "C:\\project",
      exists: (f: string) => f.toLowerCase().endsWith(".cmd"),
    }

    const plan = planSpawn("agent.cmd", ["arg 1", "arg & calc", "%VAR%"], mockOptions)
    expect(plan.command).toBe("C:\\Windows\\system32\\cmd.exe")
    expect(plan.args[0]).toBe("/d")
    expect(plan.args[1]).toBe("/s")
    expect(plan.args[2]).toBe("/c")
    expect(plan.windowsVerbatimArguments).toBe(true)

    // Command line must not contain unescaped &
    const line = plan.args[3]
    expect(line).not.toMatch(/(^|[^^])&/)
  })

  it("cronToTaskXml produces valid task XML with power and catch-up settings", () => {
    const bin = "C:\\Program Files\\YukiOshi\\yukioshi.exe"
    const xml = cronToTaskXml("test-job", "*/10 * * * *", bin, {
      XDG_CONFIG_HOME: "C:\\Users\\User\\AppData\\Roaming",
      YUKIOSHI_CONFIG_DIR: "C:\\cfg&dir",
    })

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>")
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>")
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>")
    expect(xml).toContain("<Interval>PT10M</Interval>")
    expect(xml).toContain("&amp;dir") // & is XML-escaped
    expect(xml).not.toContain("&dir") // raw & is not present
  })

  it("on real Windows: .cmd shim does not execute arguments as commands", async () => {
    if (process.platform !== "win32") return

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yk-cmd-test-"))
    const shimPath = path.join(tmpDir, "echo-shim.cmd")
    const scriptPath = path.join(tmpDir, "echo-script.js")
    const markerPath = path.join(tmpDir, "injected-marker.txt")
    const outJsonPath = path.join(tmpDir, "received-args.json")

    try {
      // Node script that records received arguments
      fs.writeFileSync(
        scriptPath,
        `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(outJsonPath)}, JSON.stringify(process.argv.slice(2)));
`,
      )

      // Standard npm-style .cmd shim
      fs.writeFileSync(
        shimPath,
        `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
node "%dp0%\\echo-script.js" %*
`,
      )

      const testArgs = [
        "simple",
        "with space",
        `& echo INJECTED > "${markerPath}"`,
        "| echo INJECTED_PIPE",
        "^ echo INJECTED_CARET",
        "%PATH%",
        'say "quoted text"',
      ]

      const plan = planSpawn(shimPath, testArgs, {
        platform: "win32",
        env: process.env,
        cwd: tmpDir,
        exists: (f) => fs.existsSync(f),
      })

      const child = spawn(plan.command, plan.args, {
        cwd: tmpDir,
        env: process.env,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", resolve)
        child.on("error", () => resolve(-1))
      })

      expect(exitCode).toBe(0)
      // CRITICAL CHECK: The command after & was NOT executed as a command
      expect(fs.existsSync(markerPath)).toBe(false)
      expect(fs.existsSync(outJsonPath)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("on real Windows: schtasks /Create /XML registers and deletes task cleanly", async () => {
    if (process.platform !== "win32") return

    const jobId = `yktest${Date.now()}`
    const xml = cronToTaskXml(jobId, "*/15 * * * *", process.execPath, {
      XDG_CONFIG_HOME: "C:\\ProgramData\\YukiOshiTest",
    })

    const xmlFile = path.join(os.tmpdir(), `test-task-${jobId}.xml`)
    await fs.promises.writeFile(
      xmlFile,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
    )

    try {
      // Create task
      const createProc = Bun.spawn(
        ["schtasks", "/Create", "/TN", `YukiOshi\\${jobId}`, "/XML", xmlFile, "/F"],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [createStderr, createCode] = await Promise.all([
        new Response(createProc.stderr).text(),
        createProc.exited,
      ])
      expect(createCode === 0, `schtasks /Create failed (code ${createCode}): ${createStderr}`)

      // Query task
      const queryProc = Bun.spawn(["schtasks", "/Query", "/TN", `YukiOshi\\${jobId}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const queryCode = await queryProc.exited
      expect(queryCode === 0, `schtasks /Query failed (code ${queryCode})`)

      // Delete task
      const deleteProc = Bun.spawn(["schtasks", "/Delete", "/TN", `YukiOshi\\${jobId}`, "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const deleteCode = await deleteProc.exited
      expect(deleteCode === 0, `schtasks /Delete failed (code ${deleteCode})`)
    } finally {
      await fs.promises.rm(xmlFile, { force: true })
    }
  })
})
