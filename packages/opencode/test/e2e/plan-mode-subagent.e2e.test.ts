import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestText, runtimeEnv } from "./helpers"

describe("plan mode in subagents", () => {
  cliIt.live(
    "--mode plan: a subagent cannot be started to write files that the rules allow",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("task", { description: "change files", prompt: "change files", subagent_type: "general" }),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("delegate the change", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--mode", "plan"],
        })
        expect(result.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1))).toContain("Plan mode refused")
        expect(fs.existsSync(path.join(home, "from-subagent.txt"))).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "without plan mode the same subagent can write",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("task", { description: "change files", prompt: "change files", subagent_type: "general" }),
          reply().tool("write", { filePath: path.join(home, "from-subagent.txt"), content: "x" }),
          reply().text("subagent done").stop(),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("delegate the change", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(path.join(home, "from-subagent.txt"))).toBe(true)
        expect(requestText((yield* llm.inputs).at(-1)!)).not.toContain("Plan mode refused")
      }),
    90_000,
  )
})
