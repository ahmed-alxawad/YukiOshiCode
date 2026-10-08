import { describe, expect, it } from "bun:test"
import { cronToSchtasksArgs, schtasksDeleteArgs } from "../../src/schedule/windows"

const NASTY = [
  "a & b",
  "a | b",
  "100%PATH%",
  "x^y",
  'say "hi"',
  "it's",
  "$(calc.exe)",
  "`calc.exe`",
  "line1\nline2",
  "line1\r\nline2",
  "日本語 тест مرحبا 🚀",
  "&|%^\"'$(`\n",
]

const BINARY = "C:\\Users\\yuki\\bin\\yukioshi.exe"

describe("schtasks arguments", () => {
  it("returns an array of separate arguments, never one shell string", () => {
    const args = cronToSchtasksArgs("job_1-a", "0 9 * * 1-5", BINARY)
    expect(Array.isArray(args)).toBe(true)
    expect(args.every((a) => typeof a === "string")).toBe(true)
    expect(args[0]).toBe("/Create")
    expect(args[args.indexOf("/TN") + 1]).toBe("YukiOshi\\job_1-a")
    expect(args[args.indexOf("/TR") + 1]).toBe(`"${BINARY}" schedule run job_1-a`)
    expect(schtasksDeleteArgs("job_1-a")).toEqual(["/Delete", "/TN", "YukiOshi\\job_1-a", "/F"])
  })

  it("the mapping only receives id, cron and binary, so prompt, name, directory and model cannot reach it", () => {
    expect(cronToSchtasksArgs.length).toBe(3)
    expect(schtasksDeleteArgs.length).toBe(1)
  })

  for (const nasty of NASTY) {
    const label = JSON.stringify(nasty)

    it(`a job id containing ${label} is rejected and never reaches /TN or /TR`, () => {
      for (const id of [nasty, `job${nasty}`, `${nasty}job`]) {
        expect(() => cronToSchtasksArgs(id, "0 * * * *", BINARY)).toThrow("Invalid job ID")
        expect(() => schtasksDeleteArgs(id)).toThrow("Invalid job ID")
      }
    })

    it(`a cron expression containing ${label} is rejected and never reaches the arguments`, () => {
      expect(() => cronToSchtasksArgs("job1", `0 9 * * ${nasty}`, BINARY)).toThrow()
      expect(() => cronToSchtasksArgs("job1", `${nasty} 9 * * *`, BINARY)).toThrow()
    })

    it(`a binary path containing ${label} is either rejected or only appears inside the quoted /TR value`, () => {
      const binary = `C:\\dir${nasty}\\yukioshi.exe`
      let args: string[] | undefined
      try {
        args = cronToSchtasksArgs("job1", "0 9 * * *", binary)
      } catch (e) {
        expect(String(e)).toContain("Invalid binary path")
        return
      }
      // Accepted: it must be one argument, fully enclosed by the quotes the code adds, with no quote inside.
      expect(nasty.includes('"')).toBe(false)
      expect(nasty.includes("\n") || nasty.includes("\r")).toBe(false)
      const tr = args[args.indexOf("/TR") + 1]!
      expect(tr).toBe(`"${binary}" schedule run job1`)
      expect(args.filter((a) => a.includes("yukioshi.exe"))).toHaveLength(1)
    })
  }

  it("every other argument is a fixed switch, keyword, number, time or day list", () => {
    const crons = [
      "* * * * *",
      "*/5 * * * *",
      "7 * * * *",
      "7 */3 * * *",
      "30 14 * * *",
      "0 9 * * mon-fri",
      "0 9 * * 1,3",
      "0 12 15 * *",
    ]
    for (const cron of crons) {
      const args = cronToSchtasksArgs("jobX", cron, BINARY)
      const tn = args.indexOf("/TN")
      const tr = args.indexOf("/TR")
      for (const [i, a] of args.entries()) {
        if (i === tn + 1 || i === tr + 1) continue
        expect(a).toMatch(/^(\/[A-Za-z]+|[A-Z]+|[A-Z]{3}(,[A-Z]{3})*|\d{1,2}|\d{2}:\d{2})$/)
      }
    }
  })
})
