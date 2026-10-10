import { describe, expect, test } from "bun:test"
import { cliErrorMessage, errorData, errorFormat, errorMessage } from "../../src/util/error"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

describe("error text printed on a crash", () => {
  test("errorMessage masks a key in the message", () => {
    expect(errorMessage(new Error(`401 for key ${openai}`))).not.toContain(openai)
    expect(errorMessage({ message: `token=${github}` })).not.toContain(github)
    expect(errorMessage({ data: { message: `using ${github}` } })).not.toContain(github)
  })

  test("errorFormat masks the stack and serialized objects", () => {
    const err = new Error(`failed https://me:${github}@example.com/x`)
    expect(errorFormat(err)).not.toContain(github)
    expect(errorFormat({ command: `curl --token ${openai}` })).not.toContain(openai)
  })

  test("errorData masks every field", () => {
    const err = Object.assign(new Error(`bad ${openai}`), { responseBody: `{"key":"${github}"}` })
    err.cause = new Error(`cause ${github}`)
    const json = JSON.stringify(errorData(err))
    expect(json).not.toContain(openai)
    expect(json).not.toContain(github)
    expect(json).toContain("bad")
  })

  test("cliErrorMessage masks config errors", () => {
    const text = cliErrorMessage({ name: "ConfigJsonError", data: { path: "/x.json", message: `near ${openai}` } })
    expect(text).toContain("/x.json")
    expect(text).not.toContain(openai)
  })
})
