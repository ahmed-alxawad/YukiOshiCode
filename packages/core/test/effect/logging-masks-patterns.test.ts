import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

test("log file masks secrets by format even when the value was never registered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yukioshi-log-mask-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "test.log")

  await Effect.logError("tool failed", {
    error: `fetch https://me:${github}@example.com/repo failed`,
    command: `curl --api-key ${openai} https://example.com`,
    env: `export OPENAI_API_KEY=${openai}`,
  }).pipe(
    Effect.provide(Logger.layer([fileLogger(file, "run-b")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const text = await Bun.file(file).text()
  expect(text).toContain("tool failed")
  expect(text).toContain("example.com")
  expect(text).not.toContain(openai)
  expect(text).not.toContain(github)
})
