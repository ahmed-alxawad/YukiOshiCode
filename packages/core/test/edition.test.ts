import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { resolve } from "@yukioshi/core/edition"

const globalPath = path.resolve(import.meta.dir, "../src/global.ts")

describe("edition selection", () => {
  test("nothing defined selects the yukioshi edition, unchanged", () => {
    const edition = resolve(undefined, undefined)
    expect(edition.id).toBe("yukioshi")
    expect(edition.command).toBe("yukioshi")
    expect(edition.productName).toBe("YukiOshi Code")
    expect(edition.appDir).toBe("yukioshi")
    expect(edition.keychainService).toBe("yukioshi-code")
    expect(edition.byok).toBe(true)
    expect(edition.extraInstructionFile).toBeUndefined()
    expect(edition.learnMode).toBe(false)
    expect(edition.explanationLanguage).toBe(false)
    expect(edition.editionSkills).toBe(false)
  })

  test("kothora can be chosen by the build define or by the environment when nothing was defined", () => {
    for (const edition of [resolve("kothora", undefined), resolve(undefined, "kothora")]) {
      expect(edition.id).toBe("kothora")
      expect(edition.command).toBe("kothora")
      expect(edition.productName).toBe("Kothora Code")
      expect(edition.appDir).toBe("kothora")
      expect(edition.keychainService).toBe("kothora-code")
      expect(edition.byok).toBe(false)
      expect(edition.extraInstructionFile).toBe("KOTHORA.md")
      expect(edition.learnMode).toBe(true)
      expect(edition.explanationLanguage).toBe(true)
      expect(edition.editionSkills).toBe(true)
    }
  })

  test("a build define wins over the environment, so a shipped binary cannot be switched", () => {
    expect(resolve("yukioshi", "kothora").id).toBe("yukioshi")
    expect(resolve("kothora", "yukioshi").id).toBe("kothora")
  })

  test("an empty environment value means default, an unknown name fails loudly", () => {
    expect(resolve(undefined, "").id).toBe("yukioshi")
    expect(() => resolve("kothra", undefined)).toThrow('Unknown edition "kothra"')
    expect(() => resolve(undefined, "toString")).toThrow("Unknown edition")
  })

  test.each([
    ["kothora", "kothora"],
    [undefined, "yukioshi"],
  ])("edition %s uses the %s data directory name", async (edition, dir) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-edition-"))
    try {
      const env: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: home }
      if (edition) env["YUKIOSHI_EDITION"] = edition
      else delete env["YUKIOSHI_EDITION"]
      const proc = Bun.spawn(["bun", "-e", `await import(${JSON.stringify(globalPath)})`], {
        env,
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(await proc.exited).toBe(0)
      expect((await fs.stat(path.join(home, dir))).isDirectory()).toBe(true)
      expect(await fs.readdir(home)).toEqual([dir])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
