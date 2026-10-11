import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, waitFor } from "./helpers"

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
const unix = process.platform === "win32" ? describe.skip : describe

unix("a session whose process was killed with SIGKILL", () => {
  cliIt.live(
    "opens again, shows the interrupted turn as ended, and answers a new prompt",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const started = path.join(home, "started")
        yield* llm.push(
          reply().tool("bash", { command: `echo $$ > ${started}; exec sleep 300`, description: "wait", timeout: 600_000 }),
        )
        const env = {
          ...process.env,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          HOME: home,
          YUKIOSHI_TEST_HOME: home,
          YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
          YUKIOSHI_PURE: "1",
          YUKIOSHI_DISABLE_AUTOUPDATE: "1",
          YUKIOSHI_DISABLE_AUTOCOMPACT: "1",
          YUKIOSHI_DISABLE_MODELS_FETCH: "1",
          YUKIOSHI_AUTH_CONTENT: "{}",
          // The test preload points the database at memory; a second process must see the same file.
          YUKIOSHI_DB: "recovery.db",
        }
        const proc = Bun.spawn(
          ["bun", "run", cliEntry, "run", "--model", "test/test-model", "--dangerously-skip-permissions", "start the long command"],
          { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        )
        yield* Effect.promise(() => waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf8").trim() !== "", "the command to start", 30_000))
        const sleeper = Number(fs.readFileSync(started, "utf8").trim())
        // Kill the process the hard way: no handler can run.
        proc.kill("SIGKILL")
        yield* Effect.promise(() => proc.exited)
        // The orphaned sleep belongs to the killed process; stop it so the test leaves nothing behind.
        process.kill(sleeper, "SIGKILL")

        const listed = yield* opencode.spawn(["session", "list", "--format", "json"], { cwd: home, env: { YUKIOSHI_DB: "recovery.db" } })
        expect({ code: listed.exitCode, out: listed.stdout, err: listed.stderr }).toMatchObject({ code: 0 })
        const sessions = JSON.parse(listed.stdout) as { id: string }[]
        expect(sessions.length).toBe(1)
        const id = sessions[0]!.id

        yield* llm.text("recovered")
        const again = yield* opencode.run("are you back", { extraArgs: ["--session", id], env: { YUKIOSHI_DB: "recovery.db" } })
        expect(again.exitCode).toBe(0)
        expect(again.stdout).toContain("recovered")

        const exported = yield* opencode.spawn(["export", id], { env: { YUKIOSHI_DB: "recovery.db" } })
        const data = JSON.parse(exported.stdout) as {
          messages: { info: { role: string; time: { completed?: number }; error?: { name: string } }; parts: { type: string; state?: { status: string } }[] }[]
        }
        const interrupted = data.messages.find((message) => message.info.role === "assistant")!
        expect(interrupted.info.time.completed).toBeDefined()
        expect(interrupted.info.error?.name).toBe("MessageAbortedError")
        const tool = interrupted.parts.find((part) => part.type === "tool")
        expect(tool?.state?.status).toBe("error")
      }),
    120_000,
  )
})
