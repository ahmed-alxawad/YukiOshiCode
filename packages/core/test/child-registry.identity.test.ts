import { expect, test } from "bun:test"
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
