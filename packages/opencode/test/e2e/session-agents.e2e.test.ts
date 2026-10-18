import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestText, requestToolNames, requestToolResults, runtimeEnv } from "./helpers"

const PROMPT = "SCOUT-SYSTEM-PROMPT-7731"
const agents = JSON.stringify({
  scout: { description: "read only scout", prompt: PROMPT, tools: ["Read"], mode: "primary" },
})
const fromScout = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("USER-ASK")

describe("run --agents", () => {
  cliIt.live(
    "the agent prompt is the system prompt and its tool restriction refuses other tools",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(home, "notes.txt"), "scout notes")
        yield* llm.pushMatch(
          fromScout,
          reply().tool("bash", { command: "touch denied-file", description: "make a file" }),
          reply().tool("read", { filePath: path.join(home, "notes.txt") }),
          reply().text("finished").stop(),
        )
        const result = yield* opencode.run("USER-ASK look around", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--agents", agents, "--agent", "scout", "--dangerously-skip-permissions"],
          timeoutMs: 60_000,
        })
        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(path.join(home, "denied-file"))).toBe(false)
        const inputs = yield* llm.inputs
        const first = inputs[0]!
        const system = JSON.stringify((first.messages as { role: string; content: unknown }[]).filter((m) => m.role === "system"))
        expect(system).toContain(PROMPT)
        expect(requestToolNames(first)).not.toContain("bash")
        const results = requestToolResults(inputs.at(-1)!)
        expect(results.join("\n")).toContain("scout notes")
        expect(results[0]).not.toContain("denied-file")
      }),
    90_000,
  )

  cliIt.live(
    "a parent session deny rule still wins over a subagent's own tool allowance",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        // Non-interactive runs deny `question` at the session level; the worker allows it explicitly.
        const worker = JSON.stringify({
          worker: { description: "asks", prompt: "WORKER-PROMPT-5521", tools: ["Question", "Read"], mode: "subagent" },
        })
        const fromMain = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("USER-ASK")
        yield* llm.pushMatch(
          fromMain,
          reply().tool("task", { description: "ask", prompt: "WORKER-TASK ask", subagent_type: "worker" }),
          reply().text("main finished").stop(),
        )
        yield* llm.pushMatch(
          (hit) => requestText(hit.body).includes("WORKER-PROMPT-5521") && !fromMain(hit),
          reply().text("worker finished").stop(),
        )
        const result = yield* opencode.run("USER-ASK delegate", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--agents", worker],
          timeoutMs: 60_000,
        })
        expect(result.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        const sub = inputs.find((input) => requestText(input).includes("WORKER-PROMPT-5521"))!
        expect(requestToolNames(sub)).toContain("read")
        expect(requestToolNames(sub)).not.toContain("question")
      }),
    90_000,
  )
})
