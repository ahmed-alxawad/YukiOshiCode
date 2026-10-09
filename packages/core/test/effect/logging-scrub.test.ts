import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import { Redact } from "../../src/redact"

test("file logger masks a registered provider key and bearer tokens", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yukioshi-log-scrub-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "test.log")
  Redact.registerSecret("gw-key-LOGSCRUB98765")

  await Effect.logError("provider failed", {
    body: "echo of gw-key-LOGSCRUB98765 and Authorization: Bearer abcdefghijklmnop1234567890",
  }).pipe(
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const text = await Bun.file(file).text()
  expect(text).toContain("provider failed")
  expect(text).not.toContain("LOGSCRUB98765")
  expect(text).not.toContain("abcdefghijklmnop1234567890")
})
