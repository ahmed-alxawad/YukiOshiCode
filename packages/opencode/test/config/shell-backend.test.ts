import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Global } from "@yukioshi/core/global"
import { Npm } from "@yukioshi/core/npm"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import * as ShellBackend from "../../src/tool/shell-backend"
import { ProjectTrust } from "@/project/trust"
import { InstanceRuntime } from "@/project/instance-runtime"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import {
  provideInstanceEffect,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"

const unexpectedHttp = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected", { status: 500 }))),
)

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])
const it = testEffect(layer)

const clearEffect = Config.use
  .invalidate()
  .pipe(Effect.scoped, Effect.provide(layer), Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())))

beforeEach(() => Effect.runPromise(clearEffect))
afterEach(() => Effect.runPromise(clearEffect))

const schemaConfig = (config: object) => ({ $schema: "https://opencode.ai/config.json", ...config })
const write = (dir: string, config: object) =>
  FSUtil.use.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(schemaConfig(config)))

/** Loads the effective config for a project directory; `trusted` decides whether its config is filtered. */
const resolve = (input: { global?: object; project: object; trusted?: boolean; home?: Record<string, string>; files?: Record<string, string> }) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    if (input.global) yield* write(global, input.global)
    yield* write(directory, input.project)
    const home = yield* tmpdirScoped()
    for (const [file, text] of Object.entries(input.home ?? {})) yield* FSUtil.use.writeWithDirs(path.join(home, file), text)
    for (const [file, text] of Object.entries(input.files ?? {}))
      yield* FSUtil.use.writeWithDirs(path.join(directory, file), text)
    const previousHome = process.env.YUKIOSHI_TEST_HOME
    process.env.YUKIOSHI_TEST_HOME = home
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousHome === undefined) delete process.env.YUKIOSHI_TEST_HOME
        else process.env.YUKIOSHI_TEST_HOME = previousHome
      }),
    )
    if (input.trusted) {
      yield* Effect.promise(() => ProjectTrust.set(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(() => ProjectTrust.set(directory, false)).pipe(Effect.ignore))
    }
    const previous = Global.Path.config
    ;(Global.Path as { config: string }).config = global
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
    )
    yield* Config.use.invalidate()
    return yield* Config.use.get().pipe(
      Effect.provideService(TestInstance, { directory }),
      provideInstanceEffect(directory),
      Effect.provide(testInstanceStoreLayer),
      Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
    )
  })

describe("shell backend config", () => {
  const backend = { shell: { backend: "docker", docker: { image: "alpine" }, ssh: { host: "h" } } }

  it.effect("global config can choose a backend, the default is local", () =>
    Effect.gen(function* () {
      expect((yield* resolve({ project: {}, trusted: true })).shell).toBeUndefined()
      const config = yield* resolve({ global: backend, project: {}, trusted: true })
      expect((config.shell as any).backend).toBe("docker")
      expect((config.shell as any).docker.image).toBe("alpine")
    }),
  )

  it.effect("a project config cannot enable it, trusted or not", () =>
    Effect.gen(function* () {
      for (const trusted of [true, false]) {
        const config = yield* resolve({ project: backend, trusted })
        const shell = config.shell as any
        expect(shell?.backend).toBeUndefined()
        expect(shell?.docker).toBeUndefined()
        expect(shell?.ssh).toBeUndefined()
      }
    }),
  )
})

describe("shell backend env plumbing and limits", () => {
  const parentEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/h",
    DOCKER_HOST: "tcp://10.9.9.9:2375",
    DOCKER_CONTEXT: "remote-daemon",
    SSH_AUTH_SOCK: "/tmp/agent.42",
    HTTP_PROXY: "http://alice:Pa55w0rd@corp-proxy:3128",
    ALL_PROXY: "socks5://bob:hunter2@socks:1080",
    NO_PROXY: "localhost",
  }
  const base = { command: "echo hi", cwd: "/p", root: "/p" }
  const dockerCfg = { backend: "docker", docker: { image: "alpine" } } as const
  const sshCfg = { backend: "ssh", ssh: { host: "h" } } as const
  const forwarded = (args: string[]) => args.filter((_, i) => args[i - 1] === "-e")

  test("docker: DOCKER_HOST and DOCKER_CONTEXT reach the client, never the container", () => {
    const plan = ShellBackend.plan(dockerCfg, { ...base, env: parentEnv })
    expect(plan.env.DOCKER_HOST).toBe("tcp://10.9.9.9:2375")
    expect(plan.env.DOCKER_CONTEXT).toBe("remote-daemon")
    expect(forwarded(plan.args)).not.toContain("DOCKER_HOST")
    expect(forwarded(plan.args)).not.toContain("DOCKER_CONTEXT")
    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined()
  })

  test("docker: without a daemon selection nothing is added to the env", () => {
    const plan = ShellBackend.plan(dockerCfg, { ...base, env: { PATH: "/bin", HOME: "/h" } })
    expect(plan.env.DOCKER_HOST).toBeUndefined()
    expect(plan.env.DOCKER_CONTEXT).toBeUndefined()
  })

  test("ssh: SSH_AUTH_SOCK reaches the client, the daemon selection does not", () => {
    const plan = ShellBackend.plan(sshCfg, { ...base, env: parentEnv })
    expect(plan.env.SSH_AUTH_SOCK).toBe("/tmp/agent.42")
    expect(plan.env.DOCKER_HOST).toBeUndefined()
    expect(plan.env.DOCKER_CONTEXT).toBeUndefined()
  })

  test("credentialed proxies are forwarded without userinfo, scheme/host/port kept", () => {
    for (const cfg of [dockerCfg, sshCfg]) {
      const plan = ShellBackend.plan(cfg, { ...base, env: { ...parentEnv, HTTPS_PROXY: "http://plain-proxy:3128" } })
      expect(plan.env.HTTP_PROXY).toBe("http://corp-proxy:3128")
      expect(plan.env.ALL_PROXY).toBe("socks5://socks:1080")
      expect(plan.env.HTTPS_PROXY).toBe("http://plain-proxy:3128")
      expect(plan.env.NO_PROXY).toBe("localhost")
      expect(JSON.stringify(plan.env)).not.toContain("Pa55w0rd")
      expect(JSON.stringify(plan.env)).not.toContain("hunter2")
      if (cfg.backend === "docker") {
        expect(forwarded(plan.args)).toContain("HTTP_PROXY")
        expect(forwarded(plan.args)).toContain("ALL_PROXY")
      }
    }
  })

  test("NUL bytes in the command are rejected with a clear error", () => {
    for (const cfg of [dockerCfg, sshCfg])
      expect(() => ShellBackend.plan(cfg, { ...base, command: "echo a\u0000b", env: { PATH: "/bin" } })).toThrow(/NUL/)
  })

  test.skipIf(process.platform === "win32")("ssh: the command runs in the quoted working directory, and an unsafe cwd is rejected", () => {
    // Run the remote command string locally: it must cd into an existing folder (quotes included) and,
    // when the folder is missing on the remote, warn and still run instead of failing every command.
    const dir = mkdtempSync(path.join(os.tmpdir(), "yk-ssh-cwd-"))
    const quoted = path.join(dir, "it's here")
    mkdirSync(quoted)
    const remote = (cwd: string) =>
      Bun.spawnSync(["sh", "-c", ShellBackend.plan(sshCfg, { ...base, command: "pwd", cwd, env: { PATH: "/bin" } }).args.at(-1)!], { cwd: dir })
    const found = remote(quoted)
    expect(found.stdout.toString().trim()).toBe(quoted)
    expect(found.stderr.toString()).toBe("")
    const missing = remote(path.join(dir, "absent"))
    expect(missing.exitCode).toBe(0)
    expect(missing.stdout.toString().trim()).toBe(dir)
    expect(missing.stderr.toString()).toContain("does not exist on the remote host")
    for (const cwd of ["/p\nrm -rf /", "/p\u0000x"])
      expect(() => ShellBackend.plan(sshCfg, { ...base, cwd, env: { PATH: "/bin" } })).toThrow(/working directory/)
  })

  test("docker: a cwd outside the mounted root warns that /work is used; inside it stays quiet", () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    try {
      const outside = ShellBackend.plan(dockerCfg, { ...base, cwd: "/elsewhere", env: { PATH: "/bin" } })
      expect(outside.args[outside.args.indexOf("-w") + 1]).toBe("/work")
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("/elsewhere")
      ShellBackend.plan(dockerCfg, { ...base, cwd: "/p/sub", env: { PATH: "/bin" } })
      expect(warnings.length).toBe(1)
    } finally {
      console.warn = original
    }
  })

  test("ssh plans carry a ConnectTimeout option", () => {
    const plan = ShellBackend.plan(sshCfg, { ...base, env: { PATH: "/bin" } })
    expect(plan.args.indexOf("ConnectTimeout=10")).toBeGreaterThan(-1)
    expect(plan.args[plan.args.indexOf("ConnectTimeout=10") - 1]).toBe("-o")
  })

  // The kill tests run a stub `docker` that records argv and environment; POSIX only.
  const posix = process.platform !== "win32"
  const testPosix = posix ? test : test.skip
  const stub = (dir: string, body: string) => {
    const cap = path.join(dir, "cap")
    const bin = path.join(dir, "bin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\nprintf '%s\\0' "$@" > "${cap}.argv"\necho $$ > "${cap}.pid"\n${body}\n`,
    )
    chmodSync(path.join(bin, "docker"), 0o755)
    return { cap, bin }
  }
  const waitFor = async (file: string) => {
    for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10)
    return existsSync(file)
  }

  testPosix("killContainer spawns docker kill with the plan env, DOCKER_HOST included", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yk-kill-"))
    const cap = path.join(dir, "cap")
    const { bin } = stub(dir, `env > "${cap}.env"\n`)
    const plan = ShellBackend.plan(dockerCfg, {
      ...base,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: "/h", DOCKER_HOST: "tcp://10.9.9.9:2375", DOCKER_CONTEXT: "remote-daemon" },
    })
    ShellBackend.killContainer(plan.container!, plan.env)
    expect(await waitFor(`${cap}.env`)).toBe(true)
    const argv = readFileSync(`${cap}.argv`, "utf8").split("\0").filter(Boolean)
    expect(argv).toEqual(["kill", plan.container!])
    const childEnv = readFileSync(`${cap}.env`, "utf8")
    expect(childEnv).toContain("DOCKER_HOST=tcp://10.9.9.9:2375")
    expect(childEnv).toContain("DOCKER_CONTEXT=remote-daemon")
  })

  testPosix("killContainer surfaces docker kill failures instead of swallowing them", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yk-kill-"))
    const cap = path.join(dir, "cap")
    const { bin } = stub(dir, "exit 1\n")
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      ShellBackend.killContainer("yukioshi-deadbeefcafe", { PATH: `${bin}:${process.env.PATH}`, HOME: "/h" })
      await waitFor(`${cap}.pid`)
      for (let i = 0; i < 200 && warnings.length === 0; i++) await Bun.sleep(10)
    } finally {
      console.warn = original
    }
    expect(warnings.length).toBeGreaterThan(0)
    expect(String(warnings[0])).toContain("yukioshi-deadbeefcafe")
  })
})
