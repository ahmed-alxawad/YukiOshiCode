import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { SessionRepoMap } from "../../src/session/repo-map"

const dirs: string[] = []
function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "repomap-"))
  dirs.push(dir)
  const w = (f: string, t: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), t)
  }
  spawnSync("git", ["init", "-q"], { cwd: dir })
  w(".gitignore", "ignored/\n")
  w("core.ts", "export function coreHelper() {}\nexport class CoreThing {}\n")
  w("a.ts", "import { coreHelper } from './core'\nexport function alphaRun() { coreHelper() }\n")
  w("b.ts", "import { coreHelper, CoreThing } from './core'\nexport const betaValue = () => new CoreThing()\nexport function betaRun() { coreHelper() }\n")
  w("lonely.py", "def lonely_function():\n    pass\n")
  w("ignored/secret.ts", "export function secretThing() {}\n")
  return { dir, w }
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe("repo map", () => {
  test("ranks the most referenced file first, lists definitions, skips gitignored files", () => {
    const { dir } = repo()
    const text = SessionRepoMap.build(dir, 1024)
    expect(text.indexOf("core.ts:")).toBeLessThan(text.indexOf("a.ts:"))
    expect(text).toContain("function coreHelper")
    expect(text).toContain("class CoreThing")
    expect(text).toContain("def lonely_function")
    expect(text).not.toContain("secretThing")
  })

  test("ranking is deterministic", () => {
    const { dir } = repo()
    const first = SessionRepoMap.build(dir, 1024)
    const again = SessionRepoMap.build(dir, 1024 + 0)
    fs.writeFileSync(path.join(dir, "z.ts"), "export function zed() {}\n")
    fs.rmSync(path.join(dir, "z.ts"))
    expect(SessionRepoMap.build(dir, 1024)).toBe(first)
    expect(again).toBe(first)
  })

  test("the budget is respected", () => {
    const { dir, w } = repo()
    for (let i = 0; i < 40; i++) w(`gen/f${i}.ts`, `export function generated${i}() {}\n`)
    const text = SessionRepoMap.build(dir, 60)
    expect(SessionRepoMap.estimateTokens(text)).toBeLessThanOrEqual(60)
    expect(text.length).toBeGreaterThan(0)
    expect(SessionRepoMap.estimateTokens(SessionRepoMap.build(dir, 4000))).toBeGreaterThan(60)
  })

  test("refreshes when a file changes", () => {
    const { dir, w } = repo()
    expect(SessionRepoMap.build(dir, 1024)).not.toContain("freshSymbol")
    w("new.ts", "export function freshSymbol() {}\n")
    expect(SessionRepoMap.build(dir, 1024)).toContain("freshSymbol")
  })

  test("off by default, injected only when enabled", () => {
    const { dir } = repo()
    expect(SessionRepoMap.systemText(dir, undefined)).toBeUndefined()
    expect(SessionRepoMap.systemText(dir, {})).toBeUndefined()
    expect(SessionRepoMap.systemText(dir, { enabled: false })).toBeUndefined()
    expect(SessionRepoMap.systemText(dir, { enabled: true, tokens: 512 })).toContain("coreHelper")
  })
})
