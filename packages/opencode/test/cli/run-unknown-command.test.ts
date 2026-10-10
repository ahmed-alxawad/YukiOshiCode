import { describe, expect, test } from "bun:test"
import { unknownCommandMessage } from "../../src/cli/cmd/run/outcome"

describe("yukioshi run --command with an unknown command", () => {
  test("names the command and lists the available ones", () => {
    const message = unknownCommandMessage("usage", ["review", "commit", "init"])
    expect(message).toContain('Command not found: "usage"')
    expect(message).toContain("Available commands: commit, init, review.")
    expect(message).toContain("terminal UI")
  })

  test("accepts a command that exists", () => {
    expect(unknownCommandMessage("commit", ["commit", "review"])).toBeUndefined()
  })

  test("goal and loop are handled by the session even when the list lacks them", () => {
    expect(unknownCommandMessage("goal", [])).toBeUndefined()
    expect(unknownCommandMessage("loop", ["review"])).toBeUndefined()
  })

  test("works when no command is available", () => {
    expect(unknownCommandMessage("x", [])).toBe(
      'Command not found: "x". Some slash commands, such as /usage, only exist in the terminal UI.',
    )
  })
})
