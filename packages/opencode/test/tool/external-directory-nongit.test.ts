import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstanceEffect, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// A project that is not a git repository has worktree "/". Files inside it must not ask external_directory.

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    LSP.node,
    Ripgrep.node,
    Truncate.node,
  ]),
)
const it = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

type Asked = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

function makeCtx() {
  const asked: Asked[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) => Effect.sync(() => void asked.push(req)),
  }
  return { asked, ctx }
}

const external = (asked: Asked[]) => asked.filter((req) => req.permission === "external_directory")

const scratch = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "yk-nongit-"))),
  (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
)

describe("external_directory in a project that is not a git repository", () => {
  it.instance("the instance really has worktree /", () =>
    Effect.gen(function* () {
      const { InstanceState } = yield* Effect.promise(() => import("@/effect/instance-state"))
      expect((yield* InstanceState.context).worktree).toBe("/")
    }),
  )

  it.instance("read of a file in the project does not ask", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "notes.txt"), "SMOKE-NOTES\n"))
      const { asked, ctx } = makeCtx()
      const read = yield* (yield* ReadTool).init()
      const result = yield* read.execute({ filePath: path.join(test.directory, "notes.txt") }, ctx)
      expect(result.output).toContain("SMOKE-NOTES")
      expect(external(asked)).toEqual([])
    }),
  )

  it.instance("read of a file in a subdirectory does not ask", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a", "b", "deep.txt"), "DEEP\n"))
      const { asked, ctx } = makeCtx()
      const read = yield* (yield* ReadTool).init()
      yield* read.execute({ filePath: path.join(test.directory, "a", "b", "deep.txt") }, ctx)
      expect(external(asked)).toEqual([])
    }),
  )

  it.instance("glob and grep inside the project do not ask", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sub", "x.txt"), "NEEDLE\n"))
      const { asked, ctx } = makeCtx()
      yield* (yield* GlobTool).init().pipe(
        Effect.flatMap((glob) => glob.execute({ pattern: "*.txt", path: path.join(test.directory, "sub") }, ctx)),
      )
      yield* (yield* GrepTool).init().pipe(
        Effect.flatMap((grep) => grep.execute({ pattern: "NEEDLE", path: test.directory }, ctx)),
      )
      expect(external(asked)).toEqual([])
    }),
  )

  it.instance("the helper used by write, edit and apply_patch allows new and nested files and the directory itself", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { asked, ctx } = makeCtx()
      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "new.txt"))
      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "x", "y", "new.txt"))
      yield* assertExternalDirectoryEffect(ctx, test.directory, { kind: "directory" })
      expect(external(asked)).toEqual([])
    }),
  )

  it.instance("still asks for ../outside and an absolute path outside", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { asked, ctx } = makeCtx()
      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "..", "outside", "f.txt"))
      yield* assertExternalDirectoryEffect(ctx, path.join(path.dirname(test.directory), "sibling.txt"))
      yield* assertExternalDirectoryEffect(ctx, path.join(os.tmpdir(), "yk-elsewhere", "f.txt"))
      expect(external(asked).length).toBe(3)
    }),
  )

  it.instance("still asks when a symlink inside the project points outside", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* scratch
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "TOP-SECRET"))
      yield* Effect.promise(() => fs.symlink(path.join(outside, "secret.txt"), path.join(test.directory, "link.txt")))
      yield* Effect.promise(() => fs.symlink(outside, path.join(test.directory, "linkdir"), "dir"))
      const { asked, ctx } = makeCtx()
      const read = yield* (yield* ReadTool).init()
      yield* read.execute({ filePath: path.join(test.directory, "link.txt") }, ctx)
      yield* read.execute({ filePath: path.join(test.directory, "linkdir", "secret.txt") }, ctx)
      expect(external(asked).length).toBe(2)
    }),
  )

  it.live("a project reached through a symlinked parent (macOS /var -> /private/var) does not ask", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const base = yield* scratch
      const real = path.join(base, "real")
      const link = path.join(base, "link")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(real, "project", "sub"), { recursive: true })
        await fs.symlink(real, link, "dir")
        await Bun.write(path.join(real, "project", "notes.txt"), "SMOKE-NOTES\n")
        await Bun.write(path.join(real, "project", "sub", "n.txt"), "N\n")
        await Bun.write(path.join(real, "outside.txt"), "O\n")
      })
      const project = path.join(link, "project")
      const { asked, ctx } = makeCtx()
      yield* Effect.gen(function* () {
        // the lexical spelling and the real spelling of the same file are both inside
        yield* assertExternalDirectoryEffect(ctx, path.join(project, "notes.txt"))
        yield* assertExternalDirectoryEffect(ctx, path.join(real, "project", "notes.txt"))
        yield* assertExternalDirectoryEffect(ctx, path.join(project, "sub", "missing.txt"))
        const read = yield* (yield* ReadTool).init()
        yield* read.execute({ filePath: path.join(project, "notes.txt") }, ctx)
        expect(external(asked)).toEqual([])
        // a sibling of the project is still outside, spelled either way
        yield* assertExternalDirectoryEffect(ctx, path.join(link, "outside.txt"))
        yield* assertExternalDirectoryEffect(ctx, path.join(real, "outside.txt"))
        expect(external(asked).length).toBe(2)
      }).pipe(provideInstanceEffect(project))
    }),
  )
})
