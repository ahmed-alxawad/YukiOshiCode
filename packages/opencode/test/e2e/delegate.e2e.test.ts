import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, globalConfig, requestToolNames, requestToolResults, runtimeEnv, waitFor } from "./helpers"

const mock = path.resolve(import.meta.dir, "../delegate/mock-acp-agent.ts")

function delegateConfig(mode: string, env?: Record<string, string>) {
  return {
    delegate: {
      enabled: true,
      agents: {
        mock: { command: [process.execPath, mock, mode], ...(env ? { env } : {}) },
      },
    },
  }
}

const callDelegate = (prompt: string) => reply().tool("delegate", { agent: "mock", prompt })

describe("delegate", () => {
  cliIt.live(
    "a delegated task returns its output and changed files",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, delegateConfig("write-file"))
        yield* llm.push(callDelegate("create the requested file"))
        yield* llm.text("delegation complete")
        const result = yield* opencode.run("delegate a file creation", {
          cwd: home,
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const outputs = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(outputs.at(-1)).toContain("Listing files in directory:")
        expect(outputs.at(-1)).toContain("created-by-agent.txt")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "created-by-agent.txt")).text())).toBe(
          "File content written over ACP",
        )
      }),
    60_000,
  )

  cliIt.live(
    "an external permission request becomes a YukiOshi allow or deny",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const baseEnv = runtimeEnv(home)

        globalConfig(home, delegateConfig("with-permission"))
        yield* llm.push(callDelegate("ask for permission"))
        yield* llm.text("allowed")
        const allowed = yield* opencode.run("delegate with permission allowed", {
          env: {
            ...baseEnv,
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(allowed.exitCode).toBe(0)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).at(-1)).toContain('"optionId":"allow_1"')

        yield* llm.reset
        globalConfig(home, {
          ...delegateConfig("with-permission"),
          permission: { delegate: { "*": "allow", "mock:tc_perm_01": "deny" } },
        })
        yield* llm.push(callDelegate("ask for permission"))
        yield* llm.text("denied")
        const denied = yield* opencode.run("delegate with permission denied", {
          env: {
            ...baseEnv,
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          },
        })
        expect(denied.exitCode).toBe(0)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).at(-1)).toContain('"optionId":"deny_1"')
      }),
    60_000,
  )

  cliIt.live(
    "the delegated process is gone when the run exits",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const pidFile = path.join(home, "mock-acp.pid")
        globalConfig(home, delegateConfig("normal", { MOCK_ACP_PID_FILE: pidFile }))
        yield* llm.push(callDelegate("list files"))
        yield* llm.text("done")
        const result = yield* opencode.run("delegate and clean up", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        yield* Effect.promise(() => waitFor(() => Bun.file(pidFile).exists(), "mock agent did not record its PID"))
        const pid = Number((yield* Effect.promise(() => Bun.file(pidFile).text())).trim())
        expect(pid).toBeGreaterThan(0)
        yield* Effect.promise(() =>
          waitFor(() => {
            try {
              process.kill(pid, 0)
              return false
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH"
            }
          }, `mock agent process ${pid} is still running`),
        )
      }),
    60_000,
  )

  cliIt.live(
    "delegate is off by default",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("done")
        const result = yield* opencode.run("inspect the default tools", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
        })
        expect(result.exitCode).toBe(0)
        const request = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        expect(requestToolNames(request)).not.toContain("delegate")
      }),
    60_000,
  )
})
