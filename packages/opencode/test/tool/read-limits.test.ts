import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Effect, Exit, Layer } from "effect"
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

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const writeRepeated = (file: string, byte: number, total: number) =>
  Effect.promise(async () => {
    const out = Bun.file(file).writer()
    const chunk = new Uint8Array(1024 * 1024).fill(byte)
    for (let written = 0; written < total; written += chunk.byteLength) out.write(chunk)
    await out.end()
  })

describe("tool.read limits", () => {
  it.instance("does not hold a huge single line in memory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "huge-line.txt")
      yield* writeRepeated(file, 97, 400 * 1024 * 1024)

      const before = process.resourceUsage().maxRSS
      const read = yield* (yield* ReadTool).init()
      const result = yield* read.execute({ filePath: file }, ctx)
      const grown = (process.resourceUsage().maxRSS - before) / 1024

      expect(result.output).toContain("line truncated to 2000 chars")
      expect(grown).toBeLessThan(250)
    }),
  )

  it.instance("refuses an image attachment above the size limit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "huge.png")
      yield* Effect.promise(() => Bun.write(file, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])))
      yield* Effect.promise(() => fs.truncate(file, 40 * 1024 * 1024))

      const read = yield* (yield* ReadTool).init()
      const exit = yield* read.execute({ filePath: file }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("too large")
    }),
  )

  it.instance("still splits lines on LF, CRLF and CR", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "mixed.txt")
      yield* Effect.promise(() => Bun.write(file, "a\r\nb\rc\n\nd"))

      const read = yield* (yield* ReadTool).init()
      const result = yield* read.execute({ filePath: file }, ctx)

      expect(result.output).toContain("1: a\n2: b\n3: c\n4: \n5: d\n")
      expect(result.output).toContain("total 5 lines")
    }),
  )
})
