import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { Config } from "@/config/config"
import { Shell } from "@yukioshi/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { JobListTool, JobStopTool, MonitorTool, backgroundShell } from "../../src/tool/background-shell"
import { BackgroundShell } from "@/background/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { spawn } from "child_process"

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)
const linux = process.platform === "linux" || process.platform === "darwin"
const live = linux ? it.live : it.live.skip

let n = 0
const context = (extra: Partial<{ ask: (req: any) => any }> = {}) => ({
  sessionID: SessionID.make(`ses_bgshell_${++n}_${Date.now()}`),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as never[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...extra,
})
type Ctx = ReturnType<typeof context>

const tools = Effect.gen(function* () {
  return {
    shell: yield* (yield* ShellTool).init(),
    monitor: yield* (yield* MonitorTool).init(),
    list: yield* (yield* JobListTool).init(),
    stop: yield* (yield* JobStopTool).init(),
  }
})

const startJob = (command: string, ctx: Ctx) =>
  Effect.gen(function* () {
    const t = yield* tools
    const result = yield* t.shell.execute({ command, background: true } as never, ctx)
    const id = (result.output.match(/job_[a-z0-9]+/) ?? [])[0]!
    return { t, id, result }
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const config = (extra: Record<string, unknown> = {}) => ({ background_shell: { enabled: true, ...extra } })

afterEach(() => BackgroundShell.reset())

describe("background shell tools", () => {
  live("starts a job, reads its output, waits for a line and stops it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const { t, id, result } = yield* startJob("echo first; sleep 1; echo ready; sleep 30", ctx)
          expect(id).toMatch(/^job_/)
          expect((result.metadata as Record<string, unknown>).background).toBe(true)
          const waited = yield* t.monitor.execute({ id, until: "ready", timeout_seconds: 10 }, ctx)
          expect(waited.output).toContain("state: running")
          expect(waited.output).toContain("a line matched")
          expect(waited.output).toContain("first")
          expect(waited.output).toContain("ready")
          // Read position moved: nothing new now.
          const again = yield* t.monitor.execute({ id }, ctx)
          expect(again.output).toContain("(no new output)")
          const listed = yield* t.list.execute({}, ctx)
          expect(listed.output).toContain(id)
          expect(listed.output).toContain("running")
          expect(listed.output).toContain("ready")
          const stopped = yield* t.stop.execute({ id }, ctx)
          expect(stopped.output).toContain("state: stopped")
          expect(BackgroundShell.get(id)?.state).toBe("stopped")
        }),
      )
    }),
  )

  live("monitor returns the exit code when the job ends", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const { t, id } = yield* startJob("echo done; exit 3", ctx)
          const out = yield* t.monitor.execute({ id, timeout_seconds: 10, until: "never-matches" }, ctx)
          expect(out.output).toContain("exited with code 3")
          expect(out.output).toContain("the job ended")
          expect(out.output).toContain("done")
        }),
      )
    }),
  )

  live("match keeps only matching new lines", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const { t, id } = yield* startJob("printf 'a1\\nerror: x\\nb2\\n'", ctx)
          const out = yield* t.monitor.execute({ id, match: "^error", timeout_seconds: 10, until: "zzz" }, ctx)
          expect(out.output).toContain("error: x")
          expect(out.output).not.toContain("a1")
        }),
      )
    }),
  )

  live("keeps a bounded rolling buffer and says how much was dropped", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config({ buffer_kb: 1 }) })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const { t, id } = yield* startJob("i=0; while [ $i -lt 400 ]; do echo line-$i-xxxxxxxxxxxx; i=$((i+1)); done", ctx)
          yield* Effect.promise(() => BackgroundShell.get(id)!.done)
          const job = BackgroundShell.get(id)!
          expect(job.buf.length).toBeLessThanOrEqual(1024)
          expect(job.base).toBeGreaterThan(0)
          const out = yield* t.monitor.execute({ id }, ctx)
          expect(out.output).toContain("dropped:")
          expect(out.output).toContain("line-399-")
          expect(out.output).not.toContain("line-0-")
        }),
      )
    }),
  )

  live("refuses a job beyond the concurrency cap", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config({ max_jobs: 2 }) })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          yield* startJob("sleep 30", ctx)
          yield* startJob("sleep 30", ctx)
          const t = yield* tools
          const exit = yield* t.shell.execute({ command: "sleep 30", background: true } as never, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause))).toContain("Too many background jobs")
          // Another session has its own cap.
          yield* startJob("sleep 30", context())
        }),
      )
    }),
  )

  live("kills the whole process group, children included", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const { t, id } = yield* startJob("sleep 300 & echo child=$!; wait", ctx)
          const out = yield* t.monitor.execute({ id, until: "child=\\d+", timeout_seconds: 10 }, ctx)
          const child = Number(/child=(\d+)/.exec(out.output)![1])
          expect(alive(child)).toBe(true)
          yield* t.stop.execute({ id }, ctx)
          yield* Effect.promise(() => sleep(300))
          expect(alive(child)).toBe(false)
        }),
      )
    }),
  )

  live("killing the session kills its jobs", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const other = context()
          const { t, id } = yield* startJob("sleep 300 & echo child=$!; wait", ctx)
          const kept = yield* startJob("sleep 300", other)
          const out = yield* t.monitor.execute({ id, until: "child=\\d+", timeout_seconds: 10 }, ctx)
          const child = Number(/child=(\d+)/.exec(out.output)![1])
          yield* Effect.promise(() => BackgroundShell.killSession(ctx.sessionID))
          expect(BackgroundShell.get(id)?.state).toBe("killed")
          yield* Effect.promise(() => sleep(300))
          expect(alive(child)).toBe(false)
          expect(BackgroundShell.get(kept.id)?.state).toBe("running")
        }),
      )
    }),
  )

  live("asks the same permission as the foreground command and sees the command", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const requests: any[] = []
          const ctx = context({
            ask: (req: any) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          })
          yield* startJob("sleep 30", ctx)
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("sleep 30")
          expect(requests[0].metadata.command).toBe("sleep 30")
          expect(requests[0].metadata.background).toBe(true)
        }),
      )
    }),
  )

  live("a denied permission starts no job", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context({ ask: () => Effect.die(new Error("denied")) })
          const t = yield* tools
          const exit = yield* t.shell.execute({ command: "sleep 30", background: true } as never, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(BackgroundShell.list().length).toBe(0)
        }),
      )
    }),
  )

  live("masks secrets in monitor output and job_list", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const ctx = context()
          const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
          const { t, id } = yield* startJob(`printf 'token %s%s\\n' ghp_ a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8; sleep 30`, ctx)
          const out = yield* t.monitor.execute({ id, until: "token", timeout_seconds: 10 }, ctx)
          expect(out.output).not.toContain(secret)
          expect(out.output).toContain("[REDACTED:")
          const listed = yield* t.list.execute({}, ctx)
          expect(listed.output).not.toContain(secret)
        }),
      )
    }),
  )

  live("is off by default: no background parameter and no job", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const t = yield* tools
          expect(JSON.stringify(t.shell.parameters.ast)).not.toContain("background")
          // The schema has no background field, so the argument is dropped and the command runs in the foreground.
          const result = yield* t.shell.execute({ command: "echo plain", background: true } as never, context())
          expect(result.output).toContain("plain")
          expect((result.metadata as Record<string, unknown>).background).toBeUndefined()
          expect(BackgroundShell.list().length).toBe(0)
        }),
      )
    }),
  )

  live("offers the background parameter when enabled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const t = yield* tools
          expect(JSON.stringify(t.shell.parameters.ast)).toContain("background")
        }),
      )
    }),
  )

  it.live("monitor rejects an unknown job and a bad regex", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: config() })
      yield* provideInstance(tmp)(
        Effect.gen(function* () {
          const t = yield* tools
          const exit = yield* t.monitor.execute({ id: "job_nope" }, context()).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          const ctx = context()
          const bad = yield* t.monitor.execute({ id: "job_nope", until: "(" }, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(bad)).toBe(true)
        }),
      )
    }),
  )
})

describe("background shell switch", () => {
  it.live("is off unless the config or the flag turns it on", () =>
    Effect.sync(() => {
      expect(backgroundShell({ backgroundShell: false }, {})).toBe(false)
      expect(backgroundShell({ backgroundShell: false }, { background_shell: {} })).toBe(false)
      expect(backgroundShell({ backgroundShell: false }, { background_shell: { enabled: false } })).toBe(false)
      expect(backgroundShell({ backgroundShell: false }, { background_shell: { enabled: true } })).toBe(true)
      expect(backgroundShell({ backgroundShell: true }, {})).toBe(true)
    }),
  )
})

// The registry itself, without the tool layer: lifetime, settle and persistence.
function launcher(command: string): BackgroundShell.StartInput["launch"] {
  return (io) =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
      io.setPid(child.pid)
      child.stdout!.on("data", (data) => io.push(String(data)))
      io.signal.addEventListener("abort", () => {
        try {
          process.kill(-child.pid!, "SIGTERM")
        } catch {}
      })
      child.on("close", (code) => resolve(code))
    })
}
const begin = (command: string, extra: Partial<BackgroundShell.StartInput> = {}) =>
  BackgroundShell.start({ sessionID: "ses_reg", command, cwd: process.cwd(), launch: launcher(command), ...extra })

describe("background shell registry", () => {
  const reg = linux ? it.live : it.live.skip

  reg("kills a job after its maximum lifetime", () =>
    Effect.promise(async () => {
      const job = begin("sleep 300", { maxMs: 200 })
      await job.done
      expect(job.state).toBe("expired")
      expect(alive(job.pid!)).toBe(false)
    }),
  )

  reg("settle waits for a short job and kills a long one", () =>
    Effect.promise(async () => {
      begin("sleep 1; echo ok", { waitMs: 5000 })
      const long = begin("sleep 300", { waitMs: 300 })
      const settled = await BackgroundShell.settle()
      expect(settled).toEqual({ started: 2, finished: 1, killed: 1 })
      expect(long.state).toBe("killed")
      expect(alive(long.pid!)).toBe(false)
    }),
  )

  reg("settle with no wait kills at once", () =>
    Effect.promise(async () => {
      const job = begin("sleep 300", { waitMs: 0 })
      const started = Date.now()
      const settled = await BackgroundShell.settle()
      expect(Date.now() - started).toBeLessThan(4000)
      expect(settled).toEqual({ started: 1, finished: 0, killed: 1 })
      expect(job.state).toBe("killed")
    }),
  )

  reg("settle reports nothing when no job was started", () =>
    Effect.promise(async () => {
      expect(await BackgroundShell.settle()).toBeUndefined()
    }),
  )

  reg("writes a state file that another process can read", () =>
    Effect.promise(async () => {
      const job = begin("echo hello; sleep 300")
      await sleep(1500)
      const stored = BackgroundShell.readStored("ses_reg")
      expect(stored.map((item) => item.id)).toContain(job.id)
      expect(stored.find((item) => item.id === job.id)?.last).toContain("hello")
      await BackgroundShell.stop(job)
      expect(BackgroundShell.readStored("ses_reg").find((item) => item.id === job.id)?.state).toBe("stopped")
    }),
  )
})
