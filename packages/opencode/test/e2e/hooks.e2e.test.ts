import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, runtimeEnv } from "./helpers"

// Each hook appends the JSON it received on stdin as one line of the named file.
const record = (file: string) => ({
  command:
    process.platform === "win32"
      ? `bun -e "const fs = require('fs'); const t = await Bun.stdin.text(); if (t) fs.appendFileSync(process.argv[1], t.trim() + '\\n')"` + ` "${file}"`
      : `cat >> "${file}"; echo >> "${file}"`,
})
const lines = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

describe("hooks", () => {
  cliIt.live("adds UserPromptSubmit hook output to the real model request", ({ home, llm, opencode }) => Effect.gen(function* () {
    globalConfig(home, { hooks: { userPromptSubmit: [{ command: "printf e2e-hook" }] } })
    yield* llm.text("hooked")
    const result = yield* opencode.run("hello", { env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) } })
    expect(result.exitCode).toBe(0)
    expect(JSON.stringify(yield* llm.inputs)).toContain("e2e-hook")
  }), 60_000)
  cliIt.live(
    "stop runs for the session you started, and subagentStop for its subagents",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const stops = path.join(home, "stop.log")
        const subagentStops = path.join(home, "subagent-stop.log")
        globalConfig(home, { hooks: { stop: [record(stops)], subagentStop: [record(subagentStops)] } })
        yield* llm.push(
          reply().tool("task", { description: "look around", prompt: "look around", subagent_type: "general" }),
          reply().text("looked around").stop(),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("check the project", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const stop = lines(stops)
        const subagent = lines(subagentStops)
        expect(stop).toHaveLength(1)
        expect(stop[0]).toMatchObject({ hook_event_name: "Stop" })
        expect(stop[0]).not.toHaveProperty("parent_session_id")
        expect(subagent).toHaveLength(1)
        expect(subagent[0]).toMatchObject({ hook_event_name: "SubagentStop", parent_session_id: stop[0]!.session_id })
      }),
    90_000,
  )

  cliIt.live(
    "preCompact runs before a long conversation is compacted",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const compacts = path.join(home, "compact.log")
        globalConfig(home, { hooks: { preCompact: [record(compacts)] } })
        fs.writeFileSync(path.join(home, "notes.txt"), "notes\n")
        // A turn that used nearly all of the 100k context makes the next step compact first.
        yield* llm.push(reply().tool("read", { filePath: path.join(home, "notes.txt") }).usage({ input: 95_000, output: 10 }))
        const result = yield* opencode.run("read the notes", {
          cwd: home,
          // The test harness turns automatic compaction off; this test needs it.
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url), YUKIOSHI_DISABLE_AUTOCOMPACT: "0" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const compact = lines(compacts)
        expect(compact.length).toBeGreaterThanOrEqual(1)
        expect(compact[0]).toMatchObject({ hook_event_name: "PreCompact", trigger: "auto" })
        expect(typeof compact[0]!.session_id).toBe("string")
      }),
    90_000,
  )
})
