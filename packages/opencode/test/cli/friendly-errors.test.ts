// Every error a user can plausibly cause on the command line must say what went wrong in plain words and what to
// do next, exit 1, and never print a stack trace or a raw error object. These tests run the real CLI.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "../e2e/helpers"
import { FormatError, FormatUnexpectedError, debugRequested, explainSessionError } from "../../src/cli/error"
import { serveStartMessage } from "../../src/cli/cmd/serve"
import { serverUnreachableMessage } from "../../src/cli/cmd/attach"
import { NOT_PACKAGE_NAMES } from "../../src/cli/cmd/plug"
import { requireTerminal } from "../../src/cli/needs-terminal"
import { Provider } from "../../src/provider/provider"

type Result = { exitCode: number; stdout: string; stderr: string }

const STACK = /\n\s+at .+\(.+:\d+:\d+\)|\n\s+at <anonymous>|\bat async \w+|Error: .*\n\s+at /

/** The command failed with exit 1, printed every expected hint, and showed no stack trace or raw object. */
function expectFriendly(result: Result, ...hints: string[]) {
  const text = result.stdout + result.stderr
  expect(result.exitCode, text).toBe(1)
  for (const hint of hints) expect(text).toContain(hint)
  expect(text).not.toMatch(STACK)
  expect(text).not.toContain("[object Object]")
  expect(text).not.toContain("Unexpected error")
}

describe("friendly CLI errors (real CLI)", () => {
  cliIt.live(
    "run: no message, unknown session, unknown agent, bad --file, bad --dir, bad --output-schema",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) }
        expectFriendly(yield* opencode.spawn(["run"], { env }), "yukioshi run", "stdin")
        expectFriendly(
          yield* opencode.spawn(["run", "--session", "ses_nope", "hi"], { env }),
          "Session not found: ses_nope",
          "yukioshi session list",
        )
        expectFriendly(
          yield* opencode.spawn(["run", "--agent", "nope", "hi"], { env }),
          'Agent not found: "nope"',
          "yukioshi agent list",
        )
        expectFriendly(yield* opencode.spawn(["run", "--file", "/no/such/file", "hi"], { env }), "--file")
        expectFriendly(yield* opencode.spawn(["run", "--dir", "/no/such/dir", "hi"], { env }), "--dir")
        expectFriendly(yield* opencode.spawn(["run", "--output-schema", "{bad", "hi"], { env }), "--output-schema")
      }),
    240_000,
  )

  cliIt.live(
    "export, import and session delete name the session or file and the command to run next",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = runtimeEnv(home)
        expectFriendly(
          yield* opencode.spawn(["export", "ses_nope"], { env }),
          "Session not found: ses_nope",
          "yukioshi session list",
        )
        expectFriendly(yield* opencode.spawn(["export"], { env }), "yukioshi export <sessionID>")
        expectFriendly(
          yield* opencode.spawn(["session", "delete", "ses_nope"], { env }),
          "Session not found: ses_nope",
          "yukioshi session list",
        )
        expectFriendly(
          yield* opencode.spawn(["import", "/no/such.json"], { env }),
          "File not found: /no/such.json",
          "yukioshi export",
        )
        expectFriendly(yield* opencode.spawn(["import", home], { env }), "not a file", ".json")
        yield* Effect.promise(() => fs.writeFile(path.join(home, "bad.json"), "{ nope"))
        expectFriendly(
          yield* opencode.spawn(["import", path.join(home, "bad.json")], { env }),
          "Invalid JSON",
          "yukioshi export",
        )
        yield* Effect.promise(() => fs.writeFile(path.join(home, "other.json"), '{"hello":1}'))
        expectFriendly(
          yield* opencode.spawn(["import", path.join(home, "other.json")], { env }),
          "not a YukiOshi session export",
          "yukioshi export",
        )
        expectFriendly(yield* opencode.spawn(["import"], { env }), "yukioshi import session.json", "--from")
        expectFriendly(yield* opencode.spawn(["import", "https://example.com/nothing"], { env }), "Not a share URL")
      }),
    240_000,
  )

  cliIt.live(
    "models, providers, trust and mcp say what to try next",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = runtimeEnv(home)
        expectFriendly(
          yield* opencode.spawn(["models", "nope"], { env }),
          "Provider not found: nope",
          "yukioshi providers login",
        )
        expectFriendly(
          yield* opencode.spawn(["providers", "login", "--provider", "nope-provider"], { env }),
          'Unknown provider "nope-provider"',
          "yukioshi models",
        )
        expectFriendly(
          yield* opencode.spawn(["providers", "login", "nope-provider"], { env }),
          "not a server address",
          "login --provider nope-provider",
        )
        expectFriendly(
          yield* opencode.spawn(["providers", "login"], { env }),
          "interactive terminal",
          "login --provider anthropic",
        )
        const logout = yield* opencode.spawn(["providers", "logout"], { env })
        expect(logout.stdout + logout.stderr).toContain("yukioshi providers login")
        expectFriendly(
          yield* opencode.spawn(["trust", "/no/such/dir"], { env }),
          "is not a directory",
          "yukioshi trust .",
        )
        expectFriendly(
          yield* opencode.spawn(["mcp", "add", "--url", "https://x.example/mcp"], { env }),
          "server name is required",
          "yukioshi mcp add my-server",
        )
        expectFriendly(yield* opencode.spawn(["mcp", "add", "srv"], { env }), "--url", "after --")
        expectFriendly(yield* opencode.spawn(["mcp", "add", "srv", "--url", "not a url"], { env }), "Invalid URL")
        expectFriendly(
          yield* opencode.spawn(["mcp", "add", "srv", "--url", "https://x.example/m", "--header", "BAD"], { env }),
          "KEY=VALUE",
        )
        expectFriendly(
          yield* opencode.spawn(["mcp", "add"], { env }),
          "interactive terminal",
          "yukioshi mcp add <name>",
        )
        expectFriendly(yield* opencode.spawn(["agent", "create"], { env }), "interactive terminal", "--description")
      }),
    240_000,
  )

  cliIt.live(
    "schedule add rejects a bad cron, empty prompt, missing directory and unknown ids with the fix",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = { ...runtimeEnv(home), YUKIOSHI_CRONTAB: path.join(home, "fake-crontab") }
        expectFriendly(
          yield* opencode.spawn(["schedule", "add", "bad cron", "do it"], { env }),
          'Invalid cron expression "bad cron"',
          "0 9 * * 1-5",
        )
        expectFriendly(
          yield* opencode.spawn(["schedule", "add", "* * * * *", "   "], { env }),
          "prompt is empty",
          "yukioshi schedule add",
        )
        expectFriendly(
          yield* opencode.spawn(["schedule", "add", "* * * * *", "do it", "--dir", "/no/such/dir"], { env }),
          "does not exist",
          "--dir",
        )
        expectFriendly(
          yield* opencode.spawn(["schedule", "add", "* * * * *", "do it", "--model", "nonsense"], { env }),
          "provider/model",
        )
        expectFriendly(
          yield* opencode.spawn(["schedule", "run", "nope"], { env }),
          "Scheduled job not found: nope",
          "yukioshi schedule list",
        )
        expectFriendly(yield* opencode.spawn(["schedule", "remove", "nope"], { env }), "yukioshi schedule list")
      }),
    240_000,
  )

  cliIt.live(
    "usage mistakes end with the reason and commands that need a repository or terminal say so",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = runtimeEnv(home)
        const usage = yield* opencode.spawn(["schedule", "add"], { env })
        expectFriendly(usage, "Error:", "--help")
        const nothing = yield* opencode.spawn(["schedule"], { env })
        expectFriendly(nothing, "Error:", "schedule action")
        expectFriendly(yield* opencode.spawn(["pr", "123"], { env }), "not a git repository", "cd into it")
        expectFriendly(yield* opencode.spawn(["checkpoint", "list"], { env }), "git init")
        expectFriendly(
          yield* opencode.spawn(["plugin", "install"], { env }),
          "not a plugin package",
          "yukioshi plugin add <git-url>",
        )
        expectFriendly(yield* opencode.spawn(["uninstall"], { env }), "--force", "--dry-run")
        expectFriendly(yield* opencode.spawn(["db", "not sql"], { env }), "SQL statement failed", "yukioshi db path")
      }),
    240_000,
  )

  cliIt.live(
    "serve explains a port that is already in use or not valid",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const env = runtimeEnv(home)
        const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") })
        try {
          const result = yield* opencode.spawn(["serve", "--port", String(blocker.port), "--hostname", "127.0.0.1"], {
            env,
          })
          expectFriendly(result, `Port ${blocker.port}`, "already in use", "--port")
        } finally {
          void blocker.stop(true)
        }
        expectFriendly(yield* opencode.spawn(["serve", "--port", "99999"], { env }), "Invalid --port", "1 to 65535")
        expectFriendly(yield* opencode.spawn(["serve", "--port", "abc"], { env }), "Invalid --port", "not a number")
      }),
    240_000,
  )
})

describe("friendly CLI errors (messages)", () => {
  test("no model and no provider tell the user to log in", () => {
    expect(new Provider.NoModelSelectedError().message).toContain("yukioshi providers login")
    expect(new Provider.NoModelSelectedError().message).toContain("--model provider/model")
    expect(new Provider.NoProvidersError().message).toContain("yukioshi providers login")
  })

  test("invalid config names the file, the key and the reason, and says what to do", () => {
    const text = FormatError({
      name: "ConfigInvalidError",
      data: { path: "/p/yukioshi.json", issues: [{ message: "Expected string, got 5", path: ["model"] }] },
    })!
    expect(text).toContain("/p/yukioshi.json")
    expect(text).toContain("model: Expected string, got 5")
    expect(text).toContain("then run the command again")
    expect(text).not.toMatch(STACK)
  })

  test("a config file that is not JSON says where, hides the echoed file and says what to do", () => {
    const text = FormatError({
      name: "ConfigJsonError",
      data: {
        path: "/p/yukioshi.json",
        message:
          '\n--- JSONC Input ---\n{ "apiKey": "sk-secretsecretsecret12345",\n--- Errors ---\nValueExpected at line 2\n--- End ---',
      },
    })!
    expect(text).toContain("/p/yukioshi.json")
    expect(text).toContain("ValueExpected at line 2")
    expect(text).toContain("Fix the syntax")
    expect(text).not.toContain("sk-secret")
  })

  test("an error nothing recognised hides the stack unless debugging was asked for", () => {
    const error = new Error("boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
    const quiet = FormatUnexpectedError(error)
    expect(quiet).toContain("boom")
    expect(quiet).toContain("--print-logs --log-level DEBUG")
    expect(quiet).not.toMatch(STACK)
    expect(quiet).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
    expect(FormatUnexpectedError(error, true)).toMatch(/\n\s+at /)
    expect(debugRequested(["run", "--log-level", "DEBUG"])).toBe(true)
    expect(debugRequested(["run", "--log-level=DEBUG"])).toBe(true)
    expect(debugRequested(["run", "--log-level", "INFO"])).toBe(false)
  })

  test("a provider that cannot be reached is named by host, keys are said to stay out of logs", () => {
    const text = explainSessionError(
      {
        name: "APIError",
        data: { metadata: { url: "https://api.example.com/v1/chat?key=sk-abcdefghijklmnopqrstuvwx" } },
      },
      "Cannot connect to API: Unable to connect.",
    )
    expect(text).toContain("could not reach api.example.com")
    expect(text).toContain("never written to the logs")
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx")
    expect(text).not.toContain("/v1/chat")
  })

  test("a rejected key points at providers login", () => {
    const text = explainSessionError(
      { name: "APIError", data: { statusCode: 401, metadata: { url: "https://api.example.com/v1" } } },
      "Unauthorized",
    )
    expect(text).toContain("api.example.com")
    expect(text).toContain("yukioshi providers login")
  })

  test("serve start failures are explained", () => {
    const busy = Object.assign(new Error("Failed to start server. Is port 4096 in use?"), { code: "EADDRINUSE" })
    expect(serveStartMessage(busy, "127.0.0.1", 4096)).toContain("already in use")
    expect(serveStartMessage(busy, "127.0.0.1", 4096)).toContain("--port")
    expect(serveStartMessage(new Error("EACCES"), "127.0.0.1", 80)).toContain("Ports below 1024")
    expect(serveStartMessage(new Error("weird"), "127.0.0.1", 1)).toContain("--print-logs")
  })

  test("attach checks the server answers before opening anything", async () => {
    expect(await serverUnreachableMessage("not a url")).toContain("http://localhost:4096")
    expect(await serverUnreachableMessage("http://127.0.0.1:1", () => Promise.reject(new Error("refused")))).toContain(
      "127.0.0.1:1",
    )
    expect(
      await serverUnreachableMessage("http://127.0.0.1:1", () => Promise.resolve(new Response("", { status: 401 }))),
    ).toBeUndefined()
  })

  test("a plugin action typed as a package name is refused", () => {
    expect(NOT_PACKAGE_NAMES.has("install")).toBe(true)
    expect(NOT_PACKAGE_NAMES.has("opencode-foo")).toBe(false)
  })

  test("prompts are refused without a terminal", async () => {
    const { Effect: E, Exit } = await import("effect")
    const exit = await E.runPromiseExit(requireTerminal("Choosing a thing", "Pass it as an argument.", false))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("needs an interactive terminal")
    expect(await E.runPromiseExit(requireTerminal("x", "y", true))).toEqual(Exit.void)
  })
})
