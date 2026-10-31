import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { startAgentProcess } from "../../src/main/agent-process"

const fakeChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => boolean
    killed: boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => (child.killed = true)
  return child
}

describe("startAgentProcess", () => {
  test("spawns the hidden API with a canonical workspace and secret only in the environment", async () => {
    const child = fakeChild()
    let call: { executable?: string; args?: readonly string[]; options?: unknown } = {}
    const started = startAgentProcess({
      executable: "/app/yukioshi",
      workspace: "/workspace/link",
      canonicalize: async () => "/workspace/real",
      random: () => new Uint8Array(32).fill(7),
      spawn: (executable, args, options) => {
        call = { executable, args, options }
        return child as never
      },
    })
    await Bun.sleep(0)
    child.stdout.emit("data", '{"type":"ready","hostname":"127.0.0.1","port":41827}\n')

    const process = await started
    expect(process.baseUrl).toBe("http://127.0.0.1:41827/")
    expect(process.token).toHaveLength(43)
    expect(call.executable).toBe("/app/yukioshi")
    expect(call.args).toEqual(["desktop-api", "/workspace/real"])
    expect(call.args?.join(" ")).not.toContain(process.token)
    const spawnOptions = call.options as { shell: boolean; env: Record<string, string> }
    expect(spawnOptions.shell).toBe(false)
    expect(spawnOptions.env.KOTHORA_DESKTOP_TOKEN).toBe(process.token)
    process.dispose()
    process.dispose()
    expect(child.killed).toBe(true)
  })

  test("fails closed for malformed, remote, and oversized ready messages", async () => {
    for (const line of [
      "not-json\n",
      '{"type":"ready","hostname":"0.0.0.0","port":41827}\n',
      `${"x".repeat(4097)}\n`,
    ]) {
      const child = fakeChild()
      const started = startAgentProcess({
        executable: "yukioshi",
        workspace: "/workspace",
        canonicalize: async (path) => path,
        spawn: () => child as never,
      })
      await Bun.sleep(0)
      child.stdout.emit("data", line)
      await expect(started).rejects.toThrow()
      expect(child.killed).toBe(true)
    }
  })

  test("times out and terminates an unready child", async () => {
    const child = fakeChild()
    await expect(
      startAgentProcess({
        executable: "yukioshi",
        workspace: "/workspace",
        timeoutMs: 5,
        canonicalize: async (path) => path,
        spawn: () => child as never,
      }),
    ).rejects.toThrow("timed out")
    expect(child.killed).toBe(true)
  })

  test("terminates a child that exits before readiness", async () => {
    const child = fakeChild()
    const started = startAgentProcess({
      executable: "yukioshi",
      workspace: "/workspace",
      canonicalize: async (path) => path,
      spawn: () => child as never,
    })
    await Bun.sleep(0)
    child.emit("exit", 1)
    await expect(started).rejects.toThrow("exited")
    expect(child.killed).toBe(true)
  })
})
