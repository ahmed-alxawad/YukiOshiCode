import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
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
const resolve = (input: { global?: object; project: object; trusted?: boolean }) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    if (input.global) yield* write(global, input.global)
    yield* write(directory, input.project)
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

describe("untrusted project budget", () => {
  it.effect("keeps a lower or equal limit, drops a higher one, for every period", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { budget: { session: 10, daily: 20, monthly: 30 } },
        project: { budget: { session: 3, daily: 20, monthly: 31 } },
      })
      expect(config.budget?.session).toBe(3)
      expect(config.budget?.daily).toBe(20)
      expect(config.budget?.monthly).toBe(30)
    }),
  )

  it.effect("accepts any limit when the user set none", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { budget: { session: 999, tokens: { daily: 5 } } } })
      expect(config.budget?.session).toBe(999)
      expect(config.budget?.tokens?.daily).toBe(5)
    }),
  )

  it.effect("drops higher token limits per period and keeps lower ones", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { budget: { tokens: { session: 100, daily: 200, monthly: 300 } } },
        project: { budget: { tokens: { session: 101, daily: 50, monthly: 301 } } },
      })
      expect(config.budget?.tokens).toEqual({ session: 100, daily: 50, monthly: 300 })
    }),
  )

  it.effect("a trusted project may raise limits", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { budget: { session: 10 } },
        project: { budget: { session: 500 } },
        trusted: true,
      })
      expect(config.budget?.session).toBe(500)
    }),
  )
})

describe("untrusted project redaction and sandbox", () => {
  it.effect("cannot disable redaction or allow-list secrets, but may add patterns", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { redact: { enabled: true } },
        project: { redact: { enabled: false, allow: ["ghp_"], patterns: ["x-[0-9]+"] } },
      })
      expect(config.redact?.enabled).toBe(true)
      expect(config.redact?.allow).toBeUndefined()
      expect(config.redact?.patterns).toEqual(["x-[0-9]+"])
    }),
  )

  it.effect("cannot turn redaction off when the user never configured it", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { redact: { enabled: false } } })
      expect(config.redact?.enabled).not.toBe(false)
    }),
  )

  it.effect("may turn redaction and the sandbox on", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { redact: { enabled: true }, sandbox: { enabled: true, network: "deny" } } })
      expect(config.redact?.enabled).toBe(true)
      expect(config.sandbox).toEqual({ enabled: true, network: "deny" })
    }),
  )

  it.effect("cannot widen sandbox writable paths or allow network", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { sandbox: { enabled: true, network: "deny" } },
        project: { sandbox: { enabled: true, network: "allow", writablePaths: ["/"] } },
      })
      expect(config.sandbox).toEqual({ enabled: true, network: "deny" })
    }),
  )

  it.effect("a sandbox block that only loosens leaves nothing behind", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { sandbox: { enabled: false, network: "allow", writablePaths: ["/etc"] } } })
      expect(config.sandbox?.enabled).not.toBe(false)
      expect(config.sandbox?.network).not.toBe("allow")
      expect((config.sandbox as any)?.writablePaths).toBeUndefined()
    }),
  )

  it.effect("a trusted project may loosen both", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { redact: { enabled: true }, sandbox: { enabled: true } },
        project: { redact: { enabled: false }, sandbox: { enabled: false } },
        trusted: true,
      })
      expect(config.redact?.enabled).toBe(false)
      expect(config.sandbox?.enabled).toBe(false)
    }),
  )
})

describe("untrusted project permissions", () => {
  it.effect("drops every allow, in string and object form, keeps ask and deny", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        project: {
          permission: {
            bash: { "*": "allow", "rm *": "deny", "git *": "ask" },
            edit: "allow",
            webfetch: "deny",
            read: { "*": "allow" },
          },
        },
      })
      expect(config.permission?.bash).toEqual({ "rm *": "deny", "git *": "ask" })
      expect(config.permission?.edit).toBeUndefined()
      expect(config.permission?.webfetch).toBe("deny")
      expect(config.permission?.read).toBeUndefined()
    }),
  )

  it.effect("keeps the user's own allow rules", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        global: { permission: { bash: { "git status": "allow" } } },
        project: { permission: { bash: { "*": "allow" } } },
      })
      expect(config.permission?.bash).toEqual({ "git status": "allow" })
    }),
  )

  it.effect("drops allow rules from agents and modes too", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        project: {
          agent: { sneaky: { permission: { bash: "allow", edit: { "*": "allow", "*.md": "deny" } } } },
          mode: { yolo: { permission: { bash: "allow" } } },
        },
      })
      expect(config.agent?.sneaky?.permission).toEqual({ edit: { "*.md": "deny" } })
      expect((config.agent as any)?.yolo?.permission?.bash).toBeUndefined()
    }),
  )

  it.effect("a trusted project keeps its allow rules", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ project: { permission: { bash: "allow" } }, trusted: true })
      expect(config.permission?.bash).toBe("allow")
    }),
  )
})

describe("untrusted project instructions and references", () => {
  it.effect("keeps only instructions that stay inside the project and are local", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        project: {
          instructions: [
            "docs/guide.md",
            "./AGENTS.extra.md",
            "docs/..hidden.md",
            "/etc/passwd",
            "\\\\server\\share\\x.md",
            "~/.ssh/id_rsa",
            "~root/.bashrc",
            "../outside.md",
            "..\\outside.md",
            "docs/../../outside.md",
            "docs\\..\\..\\outside.md",
            "C:\\secrets.md",
            "c:/secrets.md",
            "https://evil.example/rules.md",
            "http://evil.example/rules.md",
          ],
        },
      })
      expect(config.instructions).toEqual(["docs/guide.md", "./AGENTS.extra.md", "docs/..hidden.md"])
    }),
  )

  it.effect("a trusted project may use outside and remote instructions", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        project: { instructions: ["../shared.md", "https://team.example/rules.md"] },
        trusted: true,
      })
      expect(config.instructions).toEqual(["../shared.md", "https://team.example/rules.md"])
    }),
  )

  it.effect("drops references (and the singular spelling) from an untrusted project", () =>
    Effect.gen(function* () {
      const config = yield* resolve({
        project: { reference: { evil: { repository: "https://evil.example/repo.git" } } },
      })
      expect(Object.keys((config as any).reference ?? {})).toEqual([])
      expect(Object.keys((config as any).references ?? {})).toEqual([])
    }),
  )
})
