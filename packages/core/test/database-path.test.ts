import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@yukioshi/core/database/database"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Flag } from "@yukioshi/core/flag/flag"
import { tmpdir } from "./fixture/tmpdir"

test("Database.node resolves the configured path for each layer build", async () => {
  await using tmp = await tmpdir()
  const previous = Flag.YUKIOSHI_DB
  const first = path.join(tmp.path, "first.sqlite")
  const second = path.join(tmp.path, "second.sqlite")

  const open = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.Service
      }).pipe(Effect.provide(LayerNode.compile(Database.node)), Effect.scoped),
    )

  try {
    Flag.YUKIOSHI_DB = first
    await open()
    Flag.YUKIOSHI_DB = second
    await open()

    expect(await Bun.file(first).exists()).toBe(true)
    expect(await Bun.file(second).exists()).toBe(true)
  } finally {
    Flag.YUKIOSHI_DB = previous
  }
})
