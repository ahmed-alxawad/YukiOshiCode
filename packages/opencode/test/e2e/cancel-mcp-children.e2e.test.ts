import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { globalConfig, runtimeEnv, waitFor } from "./helpers"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const unix = process.platform === "win32" ? describe.skip : describe

unix("cancelling a run stops MCP stdio servers", () => {
  cliIt.live(
    "SIGINT stops the SDK-spawned MCP server and its sleep grandchild",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const fixture = path.resolve(import.meta.dir, "fixture/mcp-sleep.ts")
        const pidDir = path.join(home, "mcp-pids")
        fs.mkdirSync(pidDir, { recursive: true })
        globalConfig(home, {
          mcp: {
            sleeper: {
              type: "local",
              command: [process.execPath, fixture],
              enabled: true,
              environment: { MCP_SLEEP_FIXTURE_DIR: pidDir },
            },
          },
        })

        // A blocking bash command keeps the run alive while the MCP server starts at bootstrap.
        const pidFile = path.join(home, "bash-grandchild.pid")
        yield* llm.push(
          reply().tool("bash", {
            command: `sh -c 'sleep 300 & echo $! > ${pidFile}; wait'`,
            description: "wait",
            timeout: 600_000,
          }),
        )
        const run = yield* opencode.startRun("start the long command", {
          extraArgs: ["--dangerously-skip-permissions"],
          env: runtimeEnv(home),
        })

        const serverPidFile = path.join(pidDir, "server.pid")
        const grandchildPidFile = path.join(pidDir, "grandchild.pid")
        const readyFile = path.join(pidDir, "ready")
        // The fixture writes `ready` when the client lists tools: by then the host has connected
        // (and registered the server pid), so the SIGINT below cannot race the registration.
        yield* Effect.promise(() =>
          waitFor(
            () =>
              fs.existsSync(readyFile) &&
              fs.existsSync(serverPidFile) &&
              fs.existsSync(grandchildPidFile) &&
              fs.readFileSync(serverPidFile, "utf8").trim() !== "",
            "MCP server connected and pids written",
            30_000,
          ),
        )
        const serverPid = Number(fs.readFileSync(serverPidFile, "utf8").trim())
        const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8").trim())
        expect(alive(serverPid)).toBe(true)
        expect(alive(grandchildPid)).toBe(true)

        run.interrupt()
        const result = yield* run.result
        expect(result.exitCode).toBe(130)
        yield* Effect.promise(() => waitFor(() => !alive(serverPid), `MCP server ${serverPid} to be gone`, 5_000))
        yield* Effect.promise(() =>
          waitFor(() => !alive(grandchildPid), `MCP grandchild ${grandchildPid} to be gone`, 5_000),
        )
      }),
    90_000,
  )
})
