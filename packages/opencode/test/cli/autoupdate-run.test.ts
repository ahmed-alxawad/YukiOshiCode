// `yukioshi run` shows an earlier background update as one stderr line, never in --format json
// output, and not at all when automatic updates are off. The CLI runs from source with a release
// version compiled in through --define, because a development build ("local") never auto-updates.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "node:path"
import { AutoUpdate } from "../../src/installation/auto-update"
import { tmpdir } from "../fixture/fixture"

const cli = path.resolve(import.meta.dir, "../../src/index.ts")
const NOTICE = "YukiOshi v0.5.0 was installed in the background"

async function run(home: string, args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    YUKIOSHI_TEST_HOME: home,
    YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
    YUKIOSHI_PURE: "1",
    YUKIOSHI_DISABLE_AUTOCOMPACT: "1",
    YUKIOSHI_DISABLE_MODELS_FETCH: "1",
    YUKIOSHI_AUTH_CONTENT: "{}",
    ...extra,
  }
  delete env.YUKIOSHI_DISABLE_AUTOUPDATE
  delete env.YUKIOSHI_CONFIG_CONTENT
  if (!("CI" in extra)) delete env.CI
  if (extra.YUKIOSHI_DISABLE_AUTOUPDATE) env.YUKIOSHI_DISABLE_AUTOUPDATE = extra.YUKIOSHI_DISABLE_AUTOUPDATE
  const proc = Bun.spawn(
    [
      process.execPath,
      "--define",
      "YUKIOSHI_VERSION='0.4.1'",
      "--define",
      "YUKIOSHI_CHANNEL='latest'",
      cli,
      "run",
      "--model",
      "missing/model",
      ...args,
      "hello",
    ],
    { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr }
}

function pending(home: string, config?: object) {
  const stateDir = path.join(home, ".local/state/yukioshi")
  // Checked a minute ago, so no new background check starts during the test.
  AutoUpdate.writeState(stateDir, {
    checkedAt: Date.now() - 60_000,
    latest: "0.5.0",
    outcome: { kind: "installed", version: "0.5.0", from: "0.4.1", at: Date.now() - 60_000 },
  })
  if (config) {
    fs.mkdirSync(path.join(home, ".config/yukioshi"), { recursive: true })
    fs.writeFileSync(path.join(home, ".config/yukioshi/yukioshi.json"), JSON.stringify(config))
  }
  return stateDir
}

describe("yukioshi run automatic-update notice", () => {
  test("is one stderr line, shown once", async () => {
    await using tmp = await tmpdir()
    const stateDir = pending(tmp.path)
    const first = await run(tmp.path, [])
    expect(first.stderr.split("\n").filter((line) => line.includes(NOTICE))).toHaveLength(1)
    expect(first.stdout).not.toContain(NOTICE)
    expect(AutoUpdate.readState(stateDir).outcome?.announced).toBe(true)
    const second = await run(tmp.path, [])
    expect(second.stderr).not.toContain(NOTICE)
  }, 60_000)

  test("never appears with --format json", async () => {
    await using tmp = await tmpdir()
    const stateDir = pending(tmp.path)
    const out = await run(tmp.path, ["--format", "json"])
    expect(out.stdout + out.stderr).not.toContain(NOTICE)
    expect(AutoUpdate.readState(stateDir).outcome?.announced).toBeUndefined()
  }, 60_000)

  test('is off with "autoupdate": false', async () => {
    await using tmp = await tmpdir()
    pending(tmp.path, { autoupdate: false })
    const out = await run(tmp.path, [])
    expect(out.stderr).not.toContain(NOTICE)
  }, 60_000)

  test("is off with YUKIOSHI_DISABLE_AUTOUPDATE=1", async () => {
    await using tmp = await tmpdir()
    pending(tmp.path)
    const out = await run(tmp.path, [], { YUKIOSHI_DISABLE_AUTOUPDATE: "1" })
    expect(out.stderr).not.toContain(NOTICE)
  }, 60_000)

  test("is off in CI", async () => {
    await using tmp = await tmpdir()
    pending(tmp.path)
    const out = await run(tmp.path, [], { CI: "true" })
    expect(out.stderr).not.toContain(NOTICE)
  }, 60_000)
})
