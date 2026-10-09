import { describe, expect, it } from "bun:test"
import { spawn } from "child_process"
import { EventEmitter } from "events"
import { killProcessTree } from "../../src/delegate/client"
import { mergeEnv, planSpawn, quoteCmdArg, resolveCommand } from "../../src/delegate/spawn"

const files = (...list: string[]) => ({
  platform: "win32" as const,
  env: { Path: "C:\\bin;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
  cwd: "C:\\proj",
  exists: (f: string) => list.map((x) => x.toLowerCase()).includes(f.toLowerCase()),
})

describe("windows command resolution", () => {
  it("finds an npm .cmd shim through PATH and PATHEXT (env key spelled Path)", () => {
    expect(resolveCommand("claude", files("C:\\npm\\claude.cmd")).toLowerCase()).toBe("c:\\npm\\claude.cmd")
  })
  it("prefers earlier PATH entries and earlier extensions", () => {
    expect(resolveCommand("a", files("C:\\npm\\a.cmd", "C:\\bin\\a.exe")).toLowerCase()).toBe("c:\\bin\\a.exe")
  })
  it("leaves the name alone when nothing is found, and off Windows", () => {
    expect(resolveCommand("ghost", files())).toBe("ghost")
    expect(resolveCommand("claude", { ...files("C:\\npm\\claude.cmd"), platform: "linux" })).toBe("claude")
  })
  it("a .cmd goes through cmd.exe /d /s /c with verbatim arguments", () => {
    const plan = planSpawn("claude", ["--acp", "a b"], files("C:\\npm\\claude.cmd"))
    expect(plan.command).toBe("C:\\Windows\\system32\\cmd.exe")
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    expect(plan.args[3].startsWith('"')).toBe(true)
    expect(plan.args[3].toLowerCase()).toContain("claude.cmd")
    expect(plan.windowsVerbatimArguments).toBe(true)
  })
  it("an .exe is spawned directly", () => {
    const p = planSpawn("a", ["x"], files("C:\\bin\\a.exe"))
    expect(p.command.toLowerCase()).toBe("c:\\bin\\a.exe")
    expect(p.args).toEqual(["x"])
    expect(p.windowsVerbatimArguments).toBeUndefined()
  })
  it("quoting neutralises cmd metacharacters and rejects line breaks", () => {
    const q = quoteCmdArg('x" & calc')
    expect(q).not.toMatch(/(^|[^^])&/)
    expect(() => quoteCmdArg("a\nb")).toThrow()
  })
})

describe("env merge", () => {
  it("treats Path and PATH as one variable on win32", () => {
    expect(mergeEnv("win32", { Path: "a", X: "1" }, { PATH: "b" })).toEqual({ PATH: "b", X: "1" })
  })
  it("keeps both on posix", () => {
    expect(mergeEnv("linux", { Path: "a" }, { PATH: "b" })).toEqual({ Path: "a", PATH: "b" })
  })
})

describe("killProcessTree", () => {
  it("still kills the group when the leader was already signalled (child.killed)", async () => {
    if (process.platform === "win32") return
    const child = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
    )
    child.kill("SIGSTOP")
    expect(child.killed).toBe(true)
    await killProcessTree(child)
    await Bun.sleep(100)
    let alive = true
    try {
      process.kill(grandchild, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  it("windows: runs taskkill asynchronously with /T /F", async () => {
    const calls: unknown[][] = []
    const fake: any = (...args: unknown[]) => {
      calls.push(args)
      const ee = new EventEmitter()
      setTimeout(() => ee.emit("close", 0), 5)
      return ee
    }
    const done = killProcessTree({ pid: 42, killed: true } as any, { platform: "win32", spawnFn: fake })
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe("taskkill")
    expect(calls[0][1]).toEqual(["/pid", "42", "/T", "/F"])
    await done
  })
})
