import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { ChildRegistry } from "../src/child-registry"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("terminateAll stops a registered child and its grandchild", async () => {
  const child = spawn("sh", ["-c", "sleep 300 & echo $! ; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  ChildRegistry.track(child, true)
  const grandchild = await new Promise<number>((resolve) =>
    child.stdout!.once("data", (data) => resolve(Number(String(data).trim()))),
  )
  expect(alive(grandchild)).toBe(true)
  await ChildRegistry.terminateAll(1000)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(alive(grandchild)).toBe(false)
  expect(alive(child.pid!)).toBe(false)
})

test("SIGTERM to a process using stopOnSignals leaves no child behind", async () => {
  const script = path.join(__dirname, "child-registry.fixture.ts")
  const host = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] })
  const pids = await new Promise<number[]>((resolve) =>
    host.stdout!.once("data", (data) => resolve(String(data).trim().split(" ").map(Number))),
  )
  expect(pids.every(alive)).toBe(true)
  const exit = new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))
  host.kill("SIGTERM")
  expect(await exit).toBe(143)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(pids.map(alive)).toEqual(pids.map(() => false))
})
