import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestText, requestToolNames, requestToolResults, runtimeEnv } from "./helpers"

// Requests from the main session carry its prompt; a subagent's requests carry only the subagent's own prompt.
const MAIN = "MAIN-PROMPT"
const fromMain = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes(MAIN)
const fromSubagent = (marker: string) => (hit: { body: Record<string, unknown> }) =>
  requestText(hit.body).includes(marker) && !fromMain(hit)

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function init(directory: string) {
  git(directory, "init", "-q")
  git(directory, "config", "user.email", "e2e@example.invalid")
  git(directory, "config", "user.name", "E2E")
  fs.writeFileSync(path.join(directory, "base.txt"), "base")
  git(directory, "add", "base.txt")
  git(directory, "commit", "-qm", "base")
}

function taskTool(input: Record<string, unknown>) {
  const tools = Array.isArray(input.tools)
    ? (input.tools as { function?: { name?: string; parameters?: unknown } }[])
    : []
  return tools.find((tool) => tool.function?.name === "task")?.function?.parameters as
    | { properties?: Record<string, unknown> }
    | undefined
}

describe("subagents", () => {
  cliIt.live(
    "background and parallel subagents are off by default and on with the subagents setting",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("nothing to do")
        const off = yield* opencode.run(`${MAIN} default`, {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(off.exitCode).toBe(0)
        const offRequest = (yield* llm.inputs).find((input) => requestText(input).includes(`${MAIN} default`))!
        expect(requestToolNames(offRequest)).toContain("task")
        expect(requestToolNames(offRequest)).not.toContain("task_parallel")
        expect(taskTool(offRequest)?.properties).not.toHaveProperty("background")

        yield* llm.text("nothing to do")
        const on = yield* opencode.run(`${MAIN} enabled`, {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { subagents: { background: true, parallel: true } }),
          },
        })
        expect(on.exitCode).toBe(0)
        const onRequest = (yield* llm.inputs).find((input) => requestText(input).includes(`${MAIN} enabled`))!
        expect(requestToolNames(onRequest)).toContain("task_parallel")
        expect(taskTool(onRequest)?.properties).toHaveProperty("background")
      }),
    90_000,
  )

  cliIt.live(
    "run waits for a background subagent to report back before it exits",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.pushMatch(
          fromMain,
          reply().tool("task", {
            description: "write the note",
            prompt: "SUB-BG: write the note file",
            subagent_type: "general",
            background: true,
          }),
          reply().text("started the note in the background").stop(),
          reply().text("background finished: the note is written").stop(),
        )
        yield* llm.pushMatch(
          fromSubagent("SUB-BG"),
          reply().tool("bash", { command: "sleep 2; printf note > note.txt", description: "write the note" }),
          reply().text("note written").stop(),
        )

        const result = yield* opencode.run(`${MAIN} write a note in the background`, {
          cwd: home,
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { subagents: { background: true } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("background finished: the note is written")
        expect(fs.readFileSync(path.join(home, "note.txt"), "utf8")).toBe("note")
        const last = (yield* llm.inputs).filter((input) => requestText(input).includes(MAIN)).at(-1)!
        expect(requestText(last)).toContain('state=\\"completed\\"')
        expect(requestText(last)).toContain("note written")
      }),
    120_000,
  )

  cliIt.live(
    "a parallel subagent in its own worktree starts with the files and its changes are kept on its branch",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        init(home)
        yield* llm.pushMatch(
          fromMain,
          reply().tool("task_parallel", {
            tasks: [
              {
                description: "alpha",
                prompt: "SUB-ALPHA: copy the base file",
                subagent_type: "general",
                worktree: true,
              },
              { description: "beta", prompt: "SUB-BETA: only look around", subagent_type: "general", worktree: true },
            ],
          }),
          reply().text("both tasks finished").stop(),
        )
        // A relative path: the copy only lands in alpha's worktree if the subagent really runs there.
        yield* llm.pushMatch(
          fromSubagent("SUB-ALPHA"),
          reply().tool("bash", { command: "cat base.txt > seen.txt", description: "copy the base file" }),
          reply().text("alpha copied it").stop(),
        )
        yield* llm.pushMatch(fromSubagent("SUB-BETA"), reply().text("beta changed nothing").stop())

        const result = yield* opencode.run(`${MAIN} run two tasks`, {
          cwd: home,
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { subagents: { parallel: true } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(result.exitCode).toBe(0)

        const last = (yield* llm.inputs).filter((input) => requestText(input).includes(MAIN)).at(-1)!
        const output = requestToolResults(last).find((text) => text.includes("<parallel_task"))!
        const [alpha, beta] = output.split("</parallel_task>")
        expect(alpha).toContain('branch="yukioshi/alpha" kept="true"')
        expect(alpha).toContain("1 changed file")
        expect(beta).not.toContain("kept=")

        const alphaDir = alpha!.match(/worktree="([^"]+)"/)![1]!
        const betaDir = beta!.match(/worktree="([^"]+)"/)![1]!
        expect(fs.readFileSync(path.join(alphaDir, "seen.txt"), "utf8")).toBe("base")
        expect(git(alphaDir, "branch", "--show-current")).toBe("yukioshi/alpha")
        expect(fs.existsSync(betaDir)).toBe(false)
        expect(fs.existsSync(path.join(home, "seen.txt"))).toBe(false)
        expect(git(home, "status", "--short")).toBe("")
      }),
    120_000,
  )
})
