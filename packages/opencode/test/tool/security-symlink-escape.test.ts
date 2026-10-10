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
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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

const outsideDir = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "yk-symlink-outside-"))),
  (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
)

const external = (asked: Asked[]) => asked.filter((req) => req.permission === "external_directory")

describe("symlinks that point outside the project", () => {
  it.instance("read asks for external_directory when a file symlink leaves the project", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* outsideDir
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "TOP-SECRET"))
      yield* Effect.promise(() => fs.symlink(path.join(outside, "secret.txt"), path.join(test.directory, "link.txt")))

      const { asked, ctx } = makeCtx()
      const read = yield* (yield* ReadTool).init()
      yield* read.execute({ filePath: path.join(test.directory, "link.txt") }, ctx)

      expect(external(asked).length).toBe(1)
    }),
  )

  it.instance("read asks for external_directory when a directory symlink leaves the project", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* outsideDir
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "TOP-SECRET"))
      yield* Effect.promise(() => fs.symlink(outside, path.join(test.directory, "linkdir"), "dir"))

      const { asked, ctx } = makeCtx()
      const read = yield* (yield* ReadTool).init()
      yield* read.execute({ filePath: path.join(test.directory, "linkdir", "secret.txt") }, ctx)

      expect(external(asked).length).toBe(1)
    }),
  )

  it.instance("glob asks for external_directory when the search path is a symlink out of the project", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* outsideDir
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "TOP-SECRET"))
      yield* Effect.promise(() => fs.symlink(outside, path.join(test.directory, "linkdir"), "dir"))

      const { asked, ctx } = makeCtx()
      const glob = yield* (yield* GlobTool).init()
      yield* glob.execute({ pattern: "*", path: path.join(test.directory, "linkdir") }, ctx)

      expect(external(asked).length).toBe(1)
    }),
  )

  it.instance("grep asks for external_directory when the search path is a symlink out of the project", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* outsideDir
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "TOP-SECRET"))
      yield* Effect.promise(() => fs.symlink(outside, path.join(test.directory, "linkdir"), "dir"))

      const { asked, ctx } = makeCtx()
      const grep = yield* (yield* GrepTool).init()
      yield* grep.execute({ pattern: "TOP-SECRET", path: path.join(test.directory, "linkdir") }, ctx)

      expect(external(asked).length).toBe(1)
    }),
  )
})
