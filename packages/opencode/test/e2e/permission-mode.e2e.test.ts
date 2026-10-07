import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestToolResults, runtimeEnv } from "./helpers"

describe("permission modes in yukioshi run", () => {
  cliIt.live(
    "--mode plan refuses commands and edits that the rules allow, and still reads files",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(home, "notes.txt"), "plan notes\n")
        yield* llm.push(
          reply().tool("bash", { command: "touch from-bash", description: "create a file" }),
          reply().tool("write", { filePath: path.join(home, "from-write.txt"), content: "x" }),
          reply().tool("read", { filePath: path.join(home, "notes.txt") }),
        )
        yield* llm.text("done")
        const result = yield* opencode.run("look around", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--mode", "plan"],
        })
        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(path.join(home, "from-bash"))).toBe(false)
        expect(fs.existsSync(path.join(home, "from-write.txt"))).toBe(false)
        const results = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(results.at(-1)).toContain("plan notes")
      }),
    60_000,
  )

  cliIt.live(
    "without a mode, the default rules still allow the same command",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "touch from-bash", description: "create a file" }))
        yield* llm.text("done")
        const result = yield* opencode.run("make a file", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(path.join(home, "from-bash"))).toBe(true)
      }),
    60_000,
  )
})
