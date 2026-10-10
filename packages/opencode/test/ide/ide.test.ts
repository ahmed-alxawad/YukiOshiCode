import { describe, expect, test, afterEach } from "bun:test"
import { Ide } from "../../src/ide"

describe("ide", () => {
  const original = { ...process.env }

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      delete process.env[key]
    })
    Object.assign(process.env, original)
  })

  test("should detect Visual Studio Code", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] = "/path/to/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("Visual Studio Code")
  })

  test("should detect Visual Studio Code Insiders", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] =
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("Visual Studio Code - Insiders")
  })

  test("should detect Cursor", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] = "/path/to/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("Cursor")
  })

  test("should detect VSCodium", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] = "/path/to/VSCodium.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("VSCodium")
  })

  test("should detect Windsurf", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] = "/path/to/Windsurf.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("Windsurf")
  })

  test("should return unknown when TERM_PROGRAM is not vscode", () => {
    process.env["TERM_PROGRAM"] = "iTerm2"
    process.env["GIT_ASKPASS"] =
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions/git/dist/askpass.sh"

    expect(Ide.ide()).toBe("unknown")
  })

  test("should return unknown when GIT_ASKPASS does not contain IDE name", () => {
    process.env["TERM_PROGRAM"] = "vscode"
    process.env["GIT_ASKPASS"] = "/path/to/unknown/askpass.sh"

    expect(Ide.ide()).toBe("unknown")
  })

  test("should recognize vscode-insiders YUKIOSHI_CALLER", () => {
    process.env["YUKIOSHI_CALLER"] = "vscode-insiders"

    expect(Ide.alreadyInstalled()).toBe(true)
  })

  test("should recognize vscode YUKIOSHI_CALLER", () => {
    process.env["YUKIOSHI_CALLER"] = "vscode"

    expect(Ide.alreadyInstalled()).toBe(true)
  })

  test("should return false for unknown YUKIOSHI_CALLER", () => {
    process.env["YUKIOSHI_CALLER"] = "unknown"

    expect(Ide.alreadyInstalled()).toBe(false)
  })

  test("refuses to install unpublished extensions, prints clear message, and exits 1", async () => {
    let exitCode: number | undefined
    let stderr = ""
    const origExit = process.exit.bind(process)
    const origStderrWrite = process.stderr.write.bind(process)

    // @ts-ignore
    process.exit = (code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }
    // @ts-ignore
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    }

    try {
      await expect(Ide.install("Visual Studio Code")).rejects.toThrow("process.exit(1)")
      expect(exitCode).toBe(1)
      expect(stderr.trim()).toBe(
        "no YukiOshi editor extension is published; connect your editor over ACP: `yukioshi acp`",
      )
    } finally {
      process.exit = origExit
      process.stderr.write = origStderrWrite
    }
  })
})
