import { describe, expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

// Windows has no POSIX SIGKILL or process groups, so this behavior cannot exist there.
const unix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    }
    if (process.platform === "darwin") {
      const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()
      if (state.startsWith("Z")) return false
    }
    return true
  } catch {
    return false
  }
}
const waitFor = async (check: () => boolean, timeout: number) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("condition timed out")
}

unix("SIGKILL orphan watchdog for spawner children", () => {
  test("kills a detached bash child and its backgrounded sleep after the parent is SIGKILLed", async () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "/var/tmp", "yk-spawner-wd-"))
    const pidFile = path.join(dir, "pids")
    const spawnerPath = path.resolve(import.meta.dir, "../../../core/src/cross-spawn-spawner.ts")
    const layerPath = path.resolve(import.meta.dir, "../../../core/src/effect/layer-node.ts")
    // Same shape as the bash tool: a detached shell run through the Effect ChildProcessSpawner.
    const script = `echo $$ > ${pidFile}; sleep 300 & echo $! >> ${pidFile}; wait`
    const code = `
      import { Effect } from "effect";
      import * as ChildProcess from "effect/unstable/process/ChildProcess";
      import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
      import { LayerNode } from ${JSON.stringify(layerPath)};
      import { CrossSpawnSpawner } from ${JSON.stringify(spawnerPath)};
      const program = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner;
        yield* spawner.spawn(ChildProcess.make(${JSON.stringify(script)}, [], {
          shell: "/bin/bash", stdin: "ignore", detached: true,
        }));
        yield* Effect.never;
      }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)));
      Effect.runPromise(program).catch((e) => { console.error(e); process.exit(1) });
      setInterval(() => {}, 1000);
    `
    const parent = spawn(process.execPath, ["-e", code], { cwd: import.meta.dir, stdio: ["ignore", "pipe", "pipe"] })
    let err = ""
    parent.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString() })
    let pids: number[] = []
    try {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length === 2, 10_000).catch((e) => {
        throw new Error(`${e.message}: ${err}`)
      })
      pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number)
      expect(pids.every((pid) => Number.isInteger(pid) && pid > 0 && alive(pid))).toBe(true)
      process.kill(parent.pid!, "SIGKILL")
      await waitFor(() => pids.every((pid) => !alive(pid)), 10_000)
    } finally {
      try { parent.kill("SIGKILL") } catch {}
      for (const pid of pids) try { process.kill(pid, "SIGKILL") } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
