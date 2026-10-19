import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { rm } from "node:fs/promises"
import { Config } from "@/config/config"
import { Shell } from "@yukioshi/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"

const shellLayer = Layer.mergeAll(
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
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})


const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

import { Global } from "@yukioshi/core/global"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as ShellBackend from "../../src/tool/shell-backend"

const ctx = (abort: AbortSignal = AbortSignal.any([])) => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Fake docker and ssh: record argv (NUL separated), pid and environment, then behave like the real thing enough.
const FAKE = "/var/tmp/yk-test-f6/fake-bin-" + process.pid
const REC = FAKE + "-rec"
mkdirSync(FAKE, { recursive: true })
mkdirSync(REC, { recursive: true })
const script = (name: string, body: string) => {
  const file = path.join(FAKE, name)
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\0' "$@" > "${REC}/${name}-$$.argv"\nenv > "${REC}/${name}-$$.env"\necho $$ > "${REC}/${name}-$$.pid"\n${body}\n`,
  )
  chmodSync(file, 0o755)
}
// docker run ... image sh -c <command>: print a marker, sleep when asked to.
script("docker", `[ "$1" = kill ] && exit 0\nfor last; do :; done\ncase "$last" in *__SLEEP__*) exec sleep 30;; esac\necho "docker-ran"`)
// ssh ... -- <remote>: behave like a remote login shell, which runs the joined arguments.
script("ssh", `while [ "$1" != "--" ]; do shift; done; shift\ncase "$*" in *__SLEEP__*) exec sleep 30;; esac\nexec sh -c "$*"`)
const records = (name: string) =>
  readdirSync(REC)
    // .pid is written last by the fake script: skip records that are still being written
    .filter((f) => f.startsWith(name + "-") && f.endsWith(".argv") && existsSync(path.join(REC, f.replace(".argv", ".pid"))))
    .map((f) => ({
      argv: readFileSync(path.join(REC, f), "utf8").split("\0").slice(0, -1),
      env: readFileSync(path.join(REC, f.replace(".argv", ".env")), "utf8"),
      pid: Number(readFileSync(path.join(REC, f.replace(".argv", ".pid")), "utf8")),
    }))
const reset = () => {
  for (const f of readdirSync(REC)) require("node:fs").rmSync(path.join(REC, f))
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
process.env.PATH = FAKE + path.delimiter + process.env.PATH

const withGlobal = <A, E, R>(shell: object, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    writeFileSync(path.join(dir, "yukioshi.json"), JSON.stringify({ shell }))
    const previous = Global.Path.config
    ;(Global.Path as { config: string }).config = dir
    yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { config: string }).config = previous)))
    yield* Config.use.invalidate()
    return yield* self
  })

const docker = { backend: "docker", docker: { image: "alpine:3" } } as const
const ssh = { backend: "ssh", ssh: { host: "box.example", user: "dev", port: 2222, identity_file: "/home/me/my key" } } as const
const exec = (args: { command: string; timeout?: number }, abort?: AbortSignal) =>
  Effect.gen(function* () {
    const tool = yield* initShell()
    return yield* tool.execute({ description: "t", ...args } as any, ctx(abort))
  })

describe("shell backend plan", () => {
  const env = { PATH: "/bin", HOME: "/h", LANG: "C", OPENAI_API_KEY: "sk-secret", AWS_SECRET: "x", HTTPS_PROXY: "p" }
  const base = { command: "echo hi", cwd: "/proj/sub dir", env, root: "/proj" }

  test("docker argv: no network, project mounted, workdir mapped, env names only", () => {
    const plan = ShellBackend.plan({ backend: "docker", docker: { image: "alpine:3" } }, base)
    expect(plan.file).toBe("docker")
    const a = plan.args
    expect(a.slice(0, 3)).toEqual(["run", "--rm", "-i"])
    expect(a[a.indexOf("--network") + 1]).toBe("none")
    expect(a[a.indexOf("--mount") + 1]).toBe("type=bind,source=/proj,target=/work")
    expect(a[a.indexOf("-w") + 1]).toBe("/work/sub dir")
    expect(a.slice(-4)).toEqual(["alpine:3", "sh", "-c", "echo hi"])
    expect(a.join(" ")).not.toContain("privileged")
    expect(a.join(" ")).not.toContain("sk-secret")
    expect(a.filter((x, i) => a[i - 1] === "-e").sort()).toEqual(["HTTPS_PROXY", "LANG"])
    expect(plan.env.OPENAI_API_KEY).toBeUndefined()
    expect(plan.env.AWS_SECRET).toBeUndefined()
    expect(a[a.indexOf("--name") + 1]).toBe(plan.container!)
  })

  test("docker: cwd outside the project maps to /work, configured network is used", () => {
    const plan = ShellBackend.plan(
      { backend: "docker", docker: { image: "alpine", network: "bridge" } },
      { ...base, cwd: "/elsewhere" },
    )
    expect(plan.args[plan.args.indexOf("-w") + 1]).toBe("/work")
    expect(plan.args[plan.args.indexOf("--network") + 1]).toBe("bridge")
  })

  test("docker: option-like image, network or comma path are refused", () => {
    expect(() => ShellBackend.plan({ backend: "docker", docker: { image: "--privileged" } }, base)).toThrow()
    expect(() => ShellBackend.plan({ backend: "docker", docker: { image: "a", network: "host --x" } }, base)).toThrow()
    expect(() =>
      ShellBackend.plan({ backend: "docker", docker: { image: "a" } }, { ...base, root: "/p,readonly=false" }),
    ).toThrow()
  })

  test("ssh argv: BatchMode, strict host keys, key, port, one remote command after --", () => {
    const plan = ShellBackend.plan({ backend: "ssh", ssh: ssh.ssh }, base)
    expect(plan.file).toBe("ssh")
    expect(plan.args).toEqual([
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
      "-p", "2222", "-i", "/home/me/my key", "-o", "IdentitiesOnly=yes",
      "dev@box.example", "--", "sh -c 'echo hi'",
    ])
    expect(plan.env.OPENAI_API_KEY).toBeUndefined()
  })

  test("ssh: option-like host or user are refused", () => {
    expect(() => ShellBackend.plan({ backend: "ssh", ssh: { host: "-oProxyCommand=x" } }, base)).toThrow()
    expect(() => ShellBackend.plan({ backend: "ssh", ssh: { host: "h", user: "-x" } }, base)).toThrow()
    expect(() => ShellBackend.plan({ backend: "ssh", ssh: { host: "h", port: 70000 } }, base)).toThrow()
  })

  test("sandbox plus ssh is refused, docker and local are fine", () => {
    expect(() => ShellBackend.check({ backend: "ssh" }, true)).toThrow(/sandbox/)
    expect(() => ShellBackend.check({ backend: "ssh" }, false)).not.toThrow()
    expect(() => ShellBackend.check({ backend: "docker" }, true)).not.toThrow()
  })
})

// The fakes are POSIX sh scripts; on Windows only the real-process tests are skipped (the pure plan/quote
// tests below run everywhere).
const posix = process.platform === "win32"
const itPosix = posix ? it.live.skip : it.live
const testPosix = posix ? test.skip : test

describe("shell backend argv without executing anything", () => {
  test("ssh plan keeps the remote command as exactly one argument after --", () => {
    for (const text of [`it's "quoted"`, "$(touch PWNED); echo '", "a\nb && c"]) {
      const plan = ShellBackend.plan({ backend: "ssh", ssh: ssh.ssh }, {
        command: `printf %s ${ShellBackend.quote(text)}`, cwd: "/p", env: {}, root: "/p",
      })
      expect(plan.args.indexOf("--")).toBe(plan.args.length - 2)
      expect(plan.args.at(-1)).toStartWith("sh -c ")
    }
  })
  test("quote() wraps in single quotes and escapes embedded quotes", () => {
    expect(ShellBackend.quote("a'b")).toBe(`'a'\\''b'`)
    expect(ShellBackend.quote("$HOME `x`")).toBe("'$HOME `x`'")
  })
})

describe("shell backend execution with fake docker and ssh", () => {
  const nasty = [
    `it's "quoted" and 'single'`,
    "$(touch PWNED) `touch PWNED` ; touch PWNED",
    "line1\nline2 && touch PWNED",
    "'; touch PWNED; echo '",
    "a b\\c $HOME ${HOME}",
  ]

  testPosix("quote() survives a real shell round trip", () => {
    for (const text of nasty) {
      const out = Bun.spawnSync(["sh", "-c", `printf %s ${ShellBackend.quote(text)}`], { cwd: FAKE })
      expect(out.stdout.toString()).toBe(text)
    }
    expect(existsSync(path.join(FAKE, "PWNED"))).toBe(false)
  })

  testPosix("ssh remote command stays one command; no extra arguments or injection", () => {
    for (const text of nasty) {
      reset()
      const plan = ShellBackend.plan({ backend: "ssh", ssh: ssh.ssh }, {
        command: `printf %s ${ShellBackend.quote(text)}`, cwd: "/p", env: process.env, root: "/p",
      })
      const out = Bun.spawnSync([plan.file, ...plan.args], { env: plan.env, cwd: FAKE })
      if (out.stdout.toString() !== text) console.log(out.stderr.toString(), out.exitCode)
      expect(out.stdout.toString()).toBe(text)
      const argv = records("ssh")[0]!.argv
      expect(argv.indexOf("--")).toBe(argv.length - 2)
    }
    expect(existsSync(path.join(FAKE, "PWNED"))).toBe(false)
  })

  itPosix("docker via the shell tool: argv, workdir, filtered env, output", () =>
    Effect.gen(function* () {
      reset()
      const tmp = yield* tmpdirScoped()
      process.env.OPENAI_API_KEY = "sk-must-not-leak"
      yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.OPENAI_API_KEY))
      yield* withGlobal(docker, runIn(tmp, Effect.gen(function* () {
        const result = yield* exec({ command: `echo "it's" $(id)` })
        expect(result.output).toContain("docker-ran")
        const run = records("docker").find((r) => r.argv[0] === "run")!
        expect(run.argv.slice(-3)).toEqual(["sh", "-c", `echo "it's" $(id)`])
        expect(run.argv).toContain("--rm")
        expect(run.argv[run.argv.indexOf("--network") + 1]).toBe("none")
        expect(run.env).not.toContain("sk-must-not-leak")
        expect(run.env).not.toContain("OPENAI_API_KEY")
      })))
    }),
  )

  itPosix("docker: timeout kills the client and docker kill runs for the container", () =>
    Effect.gen(function* () {
      reset()
      const tmp = yield* tmpdirScoped()
      yield* withGlobal(docker, runIn(tmp, Effect.gen(function* () {
        const result = yield* exec({ command: "__SLEEP__", timeout: 500 })
        expect(result.metadata.exit).toBeNull()
        const run = records("docker").find((r) => r.argv[0] === "run")!
        yield* Effect.promise(() => Bun.sleep(1500))
        expect(alive(run.pid)).toBe(false)
        const killed = records("docker").find((r) => r.argv[0] === "kill")
        expect(killed?.argv[1]).toBe(run.argv[run.argv.indexOf("--name") + 1])
      })))
    }),
  )

  itPosix("ssh: abort kills the client", () =>
    Effect.gen(function* () {
      reset()
      const tmp = yield* tmpdirScoped()
      yield* withGlobal(ssh, runIn(tmp, Effect.gen(function* () {
        const controller = new AbortController()
        const timer = setInterval(() => {
          if (records("ssh").length === 0) return
          clearInterval(timer)
          controller.abort()
        }, 50)
        const result = yield* exec({ command: "__SLEEP__" }, controller.signal)
        expect(result.metadata.exit).toBeNull()
        const [rec] = records("ssh")
        yield* Effect.promise(() => Bun.sleep(1500))
        expect(alive(rec!.pid)).toBe(false)
      })))
    }),
  )

  it.live("ssh with sandbox.enabled refuses with a clear message and runs nothing", () =>
    Effect.gen(function* () {
      reset()
      const tmp = yield* tmpdirScoped({ config: { sandbox: { enabled: true } } })
      yield* withGlobal(ssh, runIn(tmp, Effect.gen(function* () {
        const exit = yield* exec({ command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toMatch(/sandbox.*ssh/s)
        expect(records("ssh").length).toBe(0)
      })))
    }),
  )

  it.live("project config cannot switch the shell to docker", () =>
    Effect.gen(function* () {
      reset()
      const tmp = yield* tmpdirScoped({ config: { shell: docker } })
      yield* runIn(tmp, Effect.gen(function* () {
        const result = yield* exec({ command: "echo local-ran" })
        expect(result.output).toContain("local-ran")
        expect(records("docker").length).toBe(0)
      }))
    }),
  )
})
