import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, runtimeEnv } from "./helpers"

function entries(home: string) {
  const dir = path.join(`${home}-state`, "yukioshi", "audit")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("audit log", () => {
  cliIt.live(
    "records tool calls and approvals with secrets masked, and a project cannot turn it off",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { audit: { enabled: true } })
        fs.writeFileSync(path.join(home, "yukioshi.json"), JSON.stringify({ audit: { enabled: false } }))
        const token = "ghp_" + "Ab1".repeat(12)
        yield* llm.push(reply().tool("bash", { command: `echo ${token} > token.txt`, description: "save" }))
        yield* llm.text("saved")
        const first = yield* opencode.run("save the token", {
          cwd: home,
          // Read the project's own config, which tries to turn the log off.
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url), YUKIOSHI_DISABLE_PROJECT_CONFIG: "0" },
        })
        expect(first.exitCode).toBe(0)

        yield* llm.push(reply().tool("bash", { command: "rm token.txt", description: "remove" }))
        yield* llm.text("could not remove it")
        const second = yield* opencode.run("remove it", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url, { permission: { bash: "ask" } }) },
        })
        expect(second.exitCode).toBe(0)

        const log = entries(home)
        const saved = log.find((entry) => entry.event === "tool" && String(entry.input).includes("token.txt"))
        expect(saved).toMatchObject({ tool: "bash", status: "completed", directory: home })
        expect(JSON.stringify(log)).not.toContain(token)
        expect(log).toContainEqual(expect.objectContaining({ event: "permission.asked", permission: "bash" }))
        expect(log).toContainEqual(expect.objectContaining({ event: "permission.replied", reply: "reject" }))
        expect(log).toContainEqual(expect.objectContaining({ event: "tool", tool: "bash", status: "error" }))
      }),
    90_000,
  )

  cliIt.live(
    "is off by default",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "echo hi", description: "say hi" }))
        yield* llm.text("done")
        const result = yield* opencode.run("say hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        expect(entries(home)).toEqual([])
      }),
    60_000,
  )
})
