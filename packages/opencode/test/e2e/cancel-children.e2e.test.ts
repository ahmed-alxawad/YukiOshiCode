import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { waitFor } from "./helpers"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A shell command that starts a grandchild, writes the grandchild's pid to a file and waits for it.
const grandchild = (file: string) => `sh -c 'sleep 300 & echo $! > ${file}; wait'`

const unix = process.platform === "win32" ? describe.skip : describe

unix("cancelling a run leaves no child process behind", () => {
  cliIt.live(
    "SIGINT stops the shell command and its grandchild,",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const pidFile = path.join(home, "grandchild.pid")
        yield* llm.push(reply().tool("bash", { command: grandchild(pidFile), description: "wait", timeout: 600_000 }))
        const run = yield* opencode.startRun("start the long command", { extraArgs: ["--dangerously-skip-permissions"] })
        yield* Effect.promise(() => waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "grandchild pid", 30_000))
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
        expect(alive(pid)).toBe(true)
        const started = Date.now()
        run.interrupt()
        const result = yield* run.result
        expect(result.exitCode).toBe(130)
        yield* Effect.promise(() => waitFor(() => !alive(pid), `grandchild ${pid} to be gone`, 5_000))
        expect(Date.now() - started).toBeLessThan(10_000)
      }),
    60_000,
  )
})
