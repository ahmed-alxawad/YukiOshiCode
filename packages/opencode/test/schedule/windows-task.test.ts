import { describe, expect, it } from "bun:test"
import { cronToSchtasksArgs, cronToTaskXml, MAX_TASK_RUN, taskRunCommand } from "../../src/schedule/windows"

const BIN = "C:\\Users\\yuki\\bin\\yukioshi.exe"

describe("windows scheduled task", () => {
  it("carries XDG and YUKIOSHI settings into the task command", () => {
    const run = taskRunCommand("j1", BIN, { XDG_CONFIG_HOME: "D:\\cfg", YUKIOSHI_CONFIG_DIR: "D:\\y" })
    expect(run).toBe(
      `cmd.exe /d /s /c "set "XDG_CONFIG_HOME=D:\\cfg" && set "YUKIOSHI_CONFIG_DIR=D:\\y" && "${BIN}" schedule run j1"`,
    )
    const args = cronToSchtasksArgs("j1", "0 9 * * *", BIN, { XDG_DATA_HOME: "D:\\d" })
    expect(args[args.indexOf("/TR") + 1]).toContain('set "XDG_DATA_HOME=D:\\d"')
  })

  it("without carried settings the command is unchanged", () => {
    expect(taskRunCommand("j1", BIN)).toBe(`"${BIN}" schedule run j1`)
  })

  it("refuses values that cmd would expand or break out of", () => {
    expect(() => taskRunCommand("j1", BIN, { XDG_DATA_HOME: "%PATH%" })).toThrow()
    expect(() => taskRunCommand("j1", BIN, { XDG_DATA_HOME: 'a"b' })).toThrow()
  })

  it("rejects a command longer than 261 characters with a clear error", () => {
    const longBin = "C:\\" + "a".repeat(MAX_TASK_RUN) + "\\yukioshi.exe"
    expect(() => cronToSchtasksArgs("j1", "0 9 * * *", longBin)).toThrow(/261/)
    expect(() => cronToSchtasksArgs("j1", "0 9 * * *", BIN)).not.toThrow()
  })

  it("the task XML lets jobs run on battery and catch up after a missed start", () => {
    const xml = cronToTaskXml("j1", "30 8 * * 1-5", BIN)
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>")
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>")
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>")
    expect(xml).toContain("<Monday />")
    expect(xml).toContain("<Friday />")
    expect(xml).toContain("T08:30:00")
    expect(xml).toContain(`<Command>${BIN}</Command>`)
    expect(xml).toContain("<Arguments>schedule run j1</Arguments>")
  })

  it("covers each schedule shape", () => {
    expect(cronToTaskXml("j", "*/5 * * * *", BIN)).toContain("PT5M")
    expect(cronToTaskXml("j", "15 */2 * * *", BIN)).toContain("PT2H")
    expect(cronToTaskXml("j", "0 9 * * *", BIN)).toContain("<DaysInterval>1</DaysInterval>")
    expect(cronToTaskXml("j", "0 9 15 * *", BIN)).toContain("<Day>15</Day>")
  })

  it("the XML runs carried settings through cmd.exe and escapes them", () => {
    const xml = cronToTaskXml("j1", "0 9 * * *", BIN, { XDG_CONFIG_HOME: "D:\\a&b" })
    expect(xml).toContain("<Command>cmd.exe</Command>")
    expect(xml).toContain("XDG_CONFIG_HOME=D:\\a&amp;b")
    expect(xml).not.toContain("a&b")
  })
})
