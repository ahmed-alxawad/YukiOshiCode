import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("shell kill_on_exit opt-in controls exit cleanup without changing daemon defaults", async () => {
  const script = path.join(__dirname, "child-registry-exit.fixture.ts")
  const run = (killOnExit: boolean) =>
    new Promise<number>((resolve, reject) => {
      const host = spawn(process.execPath, [script, String(killOnExit)], { stdio: ["ignore", "pipe", "inherit"] })
      let output = ""
      host.stdout!.on("data", (data) => (output += String(data)))
      host.once("error", reject)
      host.once("exit", (code) => {
        if (code !== 0) reject(new Error(`fixture exited with ${code}`))
        else resolve(Number(output))
      })
    })

  const survives = await run(false)
  expect(alive(survives)).toBe(true)
  process.kill(survives, "SIGKILL")

  const stops = await run(true)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(alive(stops)).toBe(false)
})
