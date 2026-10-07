import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { config, requestText, runtimeEnv } from "./helpers"

const line = (value: unknown) => JSON.stringify(value)

describe("importing conversations from other agents", () => {
  cliIt.live(
    "--from claude imports this folder's newest Claude Code conversation, and it can be continued",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const claudeDir = `${home}-claude`
        const folder = path.join(claudeDir, "projects", fs.realpathSync(home).replace(/[^a-zA-Z0-9]/g, "-"))
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(
          path.join(folder, "session.jsonl"),
          [
            line({ type: "ai-title", aiTitle: "Login fix" }),
            line({
              type: "user",
              cwd: home,
              message: { role: "user", content: "IMPORTED-QUESTION fix the login bug" },
            }),
            line({
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
            }),
            line({
              type: "user",
              message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failing" }] },
            }),
            line({
              type: "assistant",
              message: { content: [{ type: "text", text: "IMPORTED-ANSWER fixed the token check" }] },
            }),
          ].join("\n"),
        )
        const env = {
          ...runtimeEnv(home),
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          CLAUDE_CONFIG_DIR: claudeDir,
          // Tests use an in-memory database per process; the import and the run must share one.
          YUKIOSHI_DB: path.join(`${home}-data`, "sessions.db"),
        }

        const imported = yield* opencode.spawn(["import", "--from", "claude"], { cwd: home, env })
        expect(imported.exitCode).toBe(0)
        expect(imported.stdout).toContain("Imported 2 messages from Claude Code.")
        const sessionID = imported.stdout.match(/yukioshi -s (ses_\w+)/)![1]!

        yield* llm.text("We fixed the login token check.")
        const continued = yield* opencode.run("what did we do?", {
          cwd: home,
          env,
          extraArgs: ["--session", sessionID],
        })
        expect(continued.exitCode).toBe(0)
        const request = requestText((yield* llm.inputs).at(-1)!)
        expect(request).toContain("IMPORTED-QUESTION fix the login bug")
        expect(request).toContain("IMPORTED-ANSWER fixed the token check")
        expect(request).toContain("npm test")

        const missing = yield* opencode.spawn(["import", "--from", "codex"], {
          cwd: home,
          env: { ...env, CODEX_HOME: `${home}-codex` },
        })
        expect(missing.exitCode).not.toBe(0)
        expect(missing.stderr).toContain("No Codex conversation found")
      }),
    90_000,
  )

  cliIt.live(
    "a Codex transcript imports from its file",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "rollout.jsonl")
        fs.writeFileSync(
          file,
          [
            line({ type: "session_meta", payload: { cwd: home } }),
            line({
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a health check" }] },
            }),
            line({
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Added /health." }],
              },
            }),
          ].join("\n"),
        )
        const result = yield* opencode.spawn(["import", file], {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("Imported 2 messages from Codex.")
      }),
    60_000,
  )
})
