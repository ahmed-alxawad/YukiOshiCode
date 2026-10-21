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

test("terminateAll still stops a grandchild after its group leader has exited", async () => {
  // The grandchild drops the pipe, so the leader's "close" fires right after its "exit".
  const child = spawn("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $! ; exit 0"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  ChildRegistry.track(child, true)
  let output = ""
  child.stdout!.on("data", (data) => (output += data))
  await new Promise((resolve) => child.once("close", resolve))
  const grandchild = Number(output.trim())
  try {
    expect(alive(grandchild)).toBe(true)
    await ChildRegistry.terminateAll(1000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(grandchild)).toBe(false)
  } finally {
    if (alive(grandchild)) process.kill(grandchild, "SIGKILL")
  }
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

test("SIGTERM also stops a child that a worker thread started", async () => {
  const script = path.join(__dirname, "child-registry.worker-host.fixture.ts")
  const host = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] })
  const pid = await new Promise<number>((resolve) => host.stdout!.once("data", (data) => resolve(Number(String(data).trim()))))
  expect(alive(pid)).toBe(true)
  const exit = new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))
  host.kill("SIGTERM")
  expect(await exit).toBe(143)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(alive(pid)).toBe(false)
})
