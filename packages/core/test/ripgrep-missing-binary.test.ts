import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Runs the real Ripgrep + RipgrepBinary services with no `rg` on PATH, empty XDG dirs and a stubbed fetch.
// Regression: download/verification problems used to be thrown inside Effect.gen (defects), which bypassed the
// pure-JS fallback and surfaced as HTTP 503 from the file search route.
const fixture = path.join(import.meta.dir, "fixture", "ripgrep-real-binary.ts")

async function run(scenario: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-missing-"))
  const bin = path.join(home, "bin")
  await fs.mkdir(bin)
  try {
    const proc = Bun.spawn([process.execPath, fixture, scenario], {
      env: {
        ...process.env,
        PATH: bin,
        Path: bin,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: path.join(home, "local"),
        APPDATA: path.join(home, "roaming"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    const line = out.split("\n").find((l) => l.startsWith("RESULT "))
    if (!line) throw new Error(`no RESULT line\nstdout:\n${out}\nstderr:\n${err}`)
    return JSON.parse(line.slice("RESULT ".length)) as { ok: boolean; paths: string[]; error?: string; requested: string[] }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

describe("Ripgrep without a usable binary", () => {
  for (const scenario of ["reject", "http500", "badhash", "empty", "evil-redirect", "http-redirect"]) {
    test(`grep still succeeds via built-in search when the download fails (${scenario})`, async () => {
      const result = await run(scenario)
      expect(result.error).toBeUndefined()
      expect(result.ok).toBe(true)
      expect(result.paths).toEqual(["a.txt"]) // .gitignore'd ignored.txt is excluded
    }, 60_000)
  }

  test("the download request carries a timeout signal so it cannot hang forever", async () => {
    const result = await run("signal-check")
    expect(result.ok).toBe(true)
    expect(result.paths).toEqual(["a.txt"])
  }, 60_000)

  test("never contacts a host outside the allow-list", async () => {
    const result = await run("evil-redirect")
    expect(result.requested.every((u) => new URL(u).protocol === "https:" && new URL(u).hostname === "github.com")).toBe(
      true,
    )
  }, 60_000)
})
