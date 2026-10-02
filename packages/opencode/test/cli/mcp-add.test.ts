import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const cli = path.resolve(import.meta.dir, "../../src/index.ts")

async function run(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      YUKIOSHI_TEST_HOME: home,
      YUKIOSHI_CONFIG_CONTENT: "{}",
      YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
      YUKIOSHI_PURE: "1",
      YUKIOSHI_DISABLE_AUTOUPDATE: "1",
      YUKIOSHI_DISABLE_AUTOCOMPACT: "1",
      YUKIOSHI_DISABLE_MODELS_FETCH: "1",
      YUKIOSHI_AUTH_CONTENT: "{}",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0)
}

describe("yukioshi mcp add (non-interactive subprocess)", () => {
  test("adds a remote server with HTTP headers", async () => {
    await using tmp = await tmpdir()
    await run(tmp.path, [
      "mcp",
      "add",
      "github",
      "--url",
      "https://example.com/mcp",
      "--header",
      "Authorization=Bearer {env:GITHUB_TOKEN}",
      "--header",
      "X-Option=one=two",
    ])

    const config = await Bun.file(path.join(tmp.path, ".config", "yukioshi", "yukioshi.jsonc")).json()
    expect(config.mcp.github).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer {env:GITHUB_TOKEN}",
        "X-Option": "one=two",
      },
    })
  }, 60_000)

  test("adds a local server while preserving argv and environment values", async () => {
    await using tmp = await tmpdir()
    await run(tmp.path, [
      "mcp",
      "add",
      "local",
      "--env",
      "API_KEY=secret",
      "--env",
      "VALUE=one=two",
      "--",
      "npx",
      "-y",
      "@example/server",
      "--label",
      "two words",
    ])

    const config = await Bun.file(path.join(tmp.path, ".config", "yukioshi", "yukioshi.jsonc")).json()
    expect(config.mcp.local).toEqual({
      type: "local",
      command: ["npx", "-y", "@example/server", "--label", "two words"],
      environment: {
        API_KEY: "secret",
        VALUE: "one=two",
      },
    })
  }, 60_000)
})
