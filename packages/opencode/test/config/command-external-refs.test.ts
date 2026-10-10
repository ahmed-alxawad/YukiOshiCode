import { beforeEach, afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Npm } from "@yukioshi/core/npm"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Global } from "@yukioshi/core/global"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { ProjectTrust } from "@/project/trust"
import { InstanceRuntime } from "@/project/instance-runtime"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import {
  TestInstance,
  tmpdirScoped,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import fs from "fs/promises"
import path from "path"

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
    ),
  ],
])
const it = testEffect(layer)

const clear = Config.use
  .invalidate()
  .pipe(Effect.scoped, Effect.provide(layer), Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())))

beforeEach(() => Effect.runPromise(clear))
afterEach(() => Effect.runPromise(clear))

// A project at <root>/project, a global config dir, and a file outside the project at <root>/outside.txt.
const withProject = <A, E, R>(trusted: boolean, body: (input: { root: string; directory: string }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    yield* FSUtil.use.writeWithDirs(path.join(root, "outside.txt"), "secret")
    yield* FSUtil.use.writeWithDirs(path.join(directory, "inside.txt"), "fine")
    yield* FSUtil.use.writeWithDirs(
      path.join(directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
    )
    yield* Effect.promise(() => fs.symlink(path.join(root, "outside.txt"), path.join(directory, "link.txt")))
    if (trusted) {
      yield* Effect.promise(() => ProjectTrust.set(directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(() => ProjectTrust.set(directory, false)).pipe(Effect.ignore))
    }
    const previous = Global.Path.config
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = global
      }),
      () =>
        body({ root, directory }).pipe(
          Effect.provideService(TestInstance, { directory }),
          provideInstanceEffect(directory),
          Effect.provide(testInstanceStoreLayer),
          Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
        ),
      () =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
    )
  })

const write = (directory: string, name: string, text: string) =>
  FSUtil.use.writeWithDirs(path.join(directory, ".yukioshi", "command", `${name}.md`), text)

it.effect("untrusted project commands that attach files outside the project are dropped", () =>
  withProject(false, ({ root, directory }) =>
    Effect.gen(function* () {
      yield* write(directory, "home", "Look at @~/.ssh/id_rsa please\n")
      yield* write(directory, "parent", "Look at @../outside.txt please\n")
      yield* write(directory, "absolute", `Look at @${path.join(root, "outside.txt")} please\n`)
      yield* write(directory, "etc", "Look at @/etc/passwd please\n")
      yield* write(directory, "symlink", "Look at @link.txt please\n")
      yield* write(directory, "inside", "Look at @inside.txt please\n")
      yield* write(directory, "agentref", "Ask @general and @nothing-here and mail a@b.c\n")

      const commands = (yield* Config.use.get()).command ?? {}
      expect(commands.parent).toBeUndefined()
      expect(commands.absolute).toBeUndefined()
      expect(commands.etc).toBeUndefined()
      expect(commands.symlink).toBeUndefined()
      expect(commands.inside?.template).toContain("@inside.txt")
      expect(commands.agentref).toBeDefined()
    }),
  ),
)

it.effect("untrusted project commands in the project config file are filtered too", () =>
  withProject(false, ({ directory }) =>
    Effect.gen(function* () {
      yield* FSUtil.use.writeWithDirs(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          command: {
            leak: { template: "Read @/etc/passwd" },
            ok: { template: "Read @inside.txt" },
          },
        }),
      )
      const commands = (yield* Config.use.get()).command ?? {}
      expect(commands.leak).toBeUndefined()
      expect(commands.ok).toBeDefined()
    }),
  ),
)

it.effect("trusted project commands keep attaching files outside the project", () =>
  withProject(true, ({ directory }) =>
    Effect.gen(function* () {
      yield* write(directory, "parent", "Look at @../outside.txt please\n")
      yield* write(directory, "etc", "Look at @/etc/passwd please\n")
      const commands = (yield* Config.use.get()).command ?? {}
      expect(commands.parent?.template).toContain("@../outside.txt")
      expect(commands.etc?.template).toContain("@/etc/passwd")
    }),
  ),
)
