import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, requestText, requestToolResults, runtimeEnv } from "./helpers"

// The reviewer's own requests carry the action block; the agent's requests do not.
const fromReviewer = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("<action>")
const fromAgent = (hit: { body: Record<string, unknown> }) => !fromReviewer(hit)

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
  cliIt.live(
    "--mode review lets the reviewer allow or refuse actions the rules allow, and skips low-risk ones",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(home, "notes.txt"), "review notes\n")
        yield* llm.pushMatch(
          fromAgent,
          reply().tool("bash", { command: "touch wanted-file", description: "create the file" }),
          reply().tool("bash", { command: "touch unwanted-file", description: "create another file" }),
          reply().tool("read", { filePath: path.join(home, "notes.txt") }),
          reply().text("done").stop(),
        )
        yield* llm.pushMatch(
          fromReviewer,
          reply().text("ALLOW: creates the file the request asked for").stop(),
          reply().text("DENY: the request did not ask for a second file").stop(),
        )
        const result = yield* opencode.run("create wanted-file", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--mode", "review"],
        })
        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(path.join(home, "wanted-file"))).toBe(true)
        expect(fs.existsSync(path.join(home, "unwanted-file"))).toBe(false)

        const inputs = yield* llm.inputs
        const reviews = inputs.filter((input) => requestText(input).includes("<action>"))
        expect(reviews).toHaveLength(2)
        expect(requestText(reviews[0]!)).toContain("create wanted-file")
        expect(requestText(reviews[0]!)).toContain("command: touch wanted-file")
        const results = requestToolResults(inputs.filter((input) => !requestText(input).includes("<action>")).at(-1)!)
        expect(results[1]).toContain(
          "An automatic reviewer denied this tool call: the request did not ask for a second file",
        )
        expect(results[2]).toContain("review notes")
      }),
    90_000,
  )

  cliIt.live(
    "--mode review refuses an action when the reviewer gives no clear answer",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.pushMatch(
          fromAgent,
          reply().tool("bash", { command: "touch unclear-file", description: "create a file" }),
          reply().text("done").stop(),
        )
        yield* llm.pushMatch(fromReviewer, reply().text("Hmm, it depends.").stop())
        const result = yield* opencode.run("make a file", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--mode", "review"],
        })
        expect(fs.existsSync(path.join(home, "unclear-file"))).toBe(false)
        expect(result.stderr).toContain("permission requested: bash")
      }),
    60_000,
  )
})
