import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { ChildRegistry } from "../src/child-registry"

test("does not signal a registered pid when its identity has changed", async () => {
  const originalKill = process.kill
  const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal])
    return true
  }) as typeof process.kill

  try {
    ChildRegistry.trackPid(process.pid, false, "stale-process-identity")
    await ChildRegistry.terminateAll(0)
    expect(calls).toEqual([])
  } finally {
    process.kill = originalKill
    ChildRegistry.untrack(process.pid)
  }
})

test("does not signal a registered process group when its identity has changed", async () => {
  const originalKill = process.kill
  const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal])
    return true
  }) as typeof process.kill

  try {
    ChildRegistry.trackPid(process.pid, true, "stale-process-identity")
    await ChildRegistry.terminateAll(0)
    expect(calls).toEqual([])
  } finally {
    process.kill = originalKill
    ChildRegistry.untrack(process.pid)
  }
})

test("does not signal a group whose exited leader's pid now belongs to another process", async () => {
  const originalKill = process.kill
  const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal])
    return true
  }) as typeof process.kill

  try {
    // A leader that has exited while its pid is held by a live process (here: this test process).
    const leader = Object.assign(new EventEmitter(), { pid: process.pid })
    ChildRegistry.track(leader as unknown as ChildProcess, true)
    leader.emit("exit")
    await ChildRegistry.terminateAll(0)
    expect(calls).toEqual([])
  } finally {
    process.kill = originalKill
    ChildRegistry.untrack(process.pid)
  }
})
