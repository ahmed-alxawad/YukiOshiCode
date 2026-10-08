import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { filesystem } from "@yukioshi/core/effect/app-node-platform"
import { FSUtil } from "@yukioshi/core/fs-util"

// A secret file must be created owner-only, not created with the umask default and fixed up afterwards.
describe("FSUtil secret file creation mode", () => {
  const run = (use: (fs: FSUtil.Interface) => Effect.Effect<void, unknown>) => {
    const modes: Array<number | undefined> = []
    const platform = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        writeFileString: (_path, _data, options) =>
          Effect.sync(() => {
            modes.push(options?.mode)
          }),
        writeFile: (_path, _data, options) =>
          Effect.sync(() => {
            modes.push(options?.mode)
          }),
        chmod: () => Effect.void,
      }),
    )
    const layer = AppNodeBuilder.build(FSUtil.node, [[filesystem, platform]])
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* use(yield* FSUtil.Service)
      }).pipe(Effect.provide(layer)),
    ).then(() => modes)
  }

  test("writeJson passes the mode to the create call", async () => {
    expect(await run((fs) => fs.writeJson("/x/auth.json", { a: 1 }, 0o600))).toEqual([0o600])
  })

  test("writeWithDirs passes the mode to the create call", async () => {
    expect(await run((fs) => fs.writeWithDirs("/x/key", "secret", 0o600))).toEqual([0o600])
  })
})
