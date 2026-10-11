// Scenario 4: credentials must not leave the machine toward the model provider, a webhook or a hook,
// and must not be printed or stored. Fake keys are planted in the prompt, a file the model reads, tool
// arguments and results, hook output, config values and error responses; the fake servers record what
// they receive and the files and output the CLI produced are searched afterwards.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestText } from "../helpers"
import { attacker, expectClean, FAKE, FAKE_NEEDLES, makeProject, plainEnv, readAll, stopOnExit, userConfig, walk } from "./util"

const ALL = [FAKE.aws, FAKE.github, FAKE.openai, FAKE.privateKey, FAKE.postgres].join("\n")

// Files the CLI itself wrote (data, state, cache, config dirs) as raw bytes, so SQLite files count too.
function producedFiles(home: string) {
  return [`${home}-data`, `${home}-state`, `${home}-cache`].flatMap((root) => walk(root))
}
// The session database keeps the prompt the user typed verbatim (export masks it), so it is only
// searched in the run whose prompt holds no key.
const isSessionDb = (file: string) => /sessions\.db(?:-wal|-shm)?$/.test(file)
function leakedInFiles(files: string[]) {
  const found: string[] = []
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      continue
    }
    for (const needle of FAKE_NEEDLES) if (buffer.includes(needle)) found.push(`${path.basename(file)}: ${needle.slice(0, 12)}...`)
  }
  return found
}

describe("security: secrets stay local", () => {
  cliIt.live(
    "keys in the prompt, a file, tool args and results, hook output and config never reach the provider, a webhook, stdout or disk",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        fs.writeFileSync(path.join(proj, "notes.txt"), `notes\n${ALL}\n`)
        const hookLog = path.join(home, "hook-stdin.log")
        const receiver = attacker()
        yield* stopOnExit(receiver.server)
        userConfig(home, {
          hooks: { userPromptSubmit: [{ command: `cat >> "${hookLog}"; echo; echo hook-says ${FAKE.github}` }] },
          webhooks: [{ url: receiver.url, events: ["turn.finished"] }],
        })
        const env = { ...plainEnv(home, llm.url), YUKIOSHI_DB: path.join(`${home}-data`, "sessions.db") }

        yield* llm.push(
          reply().tool("read", { filePath: path.join(proj, "notes.txt") }),
          reply().tool("bash", { command: "cat notes.txt", description: "show the notes" }),
          reply().text("I read the notes").stop(),
        )
        const result = yield* opencode.run(`please use these credentials\n${ALL}`, {
          cwd: proj,
          env,
          format: "json",
          printLogs: true,
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)

        // Provider-bound request bodies: every request the fake model server received.
        const inputs = yield* llm.inputs
        expect(inputs.length).toBeGreaterThanOrEqual(3)
        expectClean("provider requests", JSON.stringify(inputs))
        expect(JSON.stringify(inputs)).toContain("[REDACTED:")
        // Positive control: the model still sees that something was there, and the real command ran.
        expect(requestText(inputs.at(-1)!)).toContain("notes")

        // What the CLI printed.
        expectClean("result.stdout", result.stdout)
        expectClean("result.stderr", result.stderr)

        // Hook payload and webhook payload.
        expect(fs.existsSync(hookLog)).toBe(true)
        expectClean("hook stdin", fs.readFileSync(hookLog, "utf8"))
        yield* Effect.sleep("500 millis")
        expect(receiver.seen.length).toBeGreaterThan(0)
        expectClean("webhook", JSON.stringify(receiver.seen))

        // Everything the CLI stored besides the session database: logs, truncated tool output, snapshots.
        expect(leakedInFiles(producedFiles(home).filter((file) => !isSessionDb(file)))).toEqual([])

        // Export, with and without --sanitize.
        const sessionID = result.stdout.match(/"sessionID":"(ses_[A-Za-z0-9]+)"/)?.[1]
        expect(sessionID).toBeDefined()
        for (const extra of [[], ["--sanitize"]]) {
          const exported = yield* opencode.spawn(["export", sessionID!, ...extra], { cwd: proj, env })
          opencode.expectExit(exported, 0, "export")
          expectClean("export", exported.stdout + exported.stderr)
        }
        const plain = yield* opencode.spawn(["export", sessionID!], { cwd: proj, env })
        expect(plain.stdout).toContain("notes")
      }),
    240_000,
  )

  cliIt.live(
    "keys in a file the model reads and in command output are not stored in the session database, logs or audit log",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        fs.writeFileSync(path.join(proj, "notes.txt"), `notes\n${ALL}\n`)
        userConfig(home, { audit: { enabled: true } })
        const env = { ...plainEnv(home, llm.url), YUKIOSHI_DB: path.join(`${home}-data`, "sessions.db") }
        yield* llm.push(
          reply().tool("read", { filePath: path.join(proj, "notes.txt") }),
          reply().tool("bash", { command: "cat notes.txt", description: "show the notes" }),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("look at the notes", { cwd: proj, env, printLogs: true, extraArgs: ["--dangerously-skip-permissions"] })
        expect(result.exitCode).toBe(0)
        expectClean("stdout", result.stdout)
        expectClean("stderr", result.stderr)
        const files = producedFiles(home)
        expect(files.some(isSessionDb)).toBe(true)
        expect(files.some((file) => file.includes(`${path.sep}audit${path.sep}`))).toBe(true)
        expect(leakedInFiles(files)).toEqual([])
      }),
    240_000,
  )

  cliIt.live(
    "keys the model itself writes into tool arguments or text are masked when they go back to the provider",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const env = { ...plainEnv(home, llm.url), YUKIOSHI_DB: path.join(`${home}-data`, "sessions.db") }
        yield* llm.push(
          reply().tool("write", { filePath: path.join(proj, "out.txt"), content: ALL }),
          reply().tool("bash", { command: `echo ${FAKE.aws} ${FAKE.postgres}`, description: "echo keys" }),
          reply().text("report written").stop(),
        )
        const result = yield* opencode.run("write the report", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"] })
        expect(result.exitCode).toBe(0)
        yield* llm.reset
        yield* llm.text("second turn")
        const again = yield* opencode.run("continue", { cwd: proj, env, extraArgs: ["--continue"] })
        expect(again.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        expect(inputs.length).toBeGreaterThan(0)
        expectClean("provider requests (history)", JSON.stringify(inputs))
        // The history reached the provider at all: the second turn carries the first turn's tool call.
        expect(JSON.stringify(inputs.at(-1))).toContain("report")
      }),
    240_000,
  )

  cliIt.live(
    "error responses that echo a key and `debug config` do not print it",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        yield* llm.error(400, { error: { message: `bad request, your key was ${FAKE.github} ${FAKE.postgres} ${FAKE.privateKey}` } })
        const env = { ...plainEnv(home, llm.url), YUKIOSHI_DB: path.join(`${home}-data`, "sessions.db") }
        const failed = yield* opencode.run("trigger an error", { cwd: proj, env, printLogs: true })
        expect(failed.exitCode).not.toBe(0)
        expect(failed.stderr + failed.stdout).toContain("bad request")
        expectClean("error output", failed.stdout + failed.stderr)
        expect(leakedInFiles(producedFiles(home))).toEqual([])

        // Keys in configuration values, under any key name, are masked in `debug config`.
        userConfig(home, {
          mcp: { remote: { type: "remote", url: "https://mcp.example.test/mcp", headers: { Authorization: `Bearer ${FAKE.github}` }, enabled: false } },
          instructions: [],
          command: { note: { template: `use ${FAKE.openai} and ${FAKE.postgres}` } },
          provider: { other: { options: { apiKey: FAKE.openai, baseURL: `https://${FAKE.postgres.split("//")[1]}` } } },
        })
        const debug = yield* opencode.spawn(["debug", "config"], { cwd: proj, env })
        expect(debug.exitCode).toBe(0)
        expect(debug.stdout).toContain("remote")
        expectClean("debug config", debug.stdout + debug.stderr)
      }),
    240_000,
  )
})
