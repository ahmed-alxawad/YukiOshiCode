import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { RipgrepBinary } from "@yukioshi/core/ripgrep/binary"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const missing = Layer.succeed(
  RipgrepBinary.Service,
  RipgrepBinary.Service.of({ filepath: Effect.fail(new Error("no ripgrep")) }),
)
// A defect (thrown error) from the binary service must also fall back.
const crashing = Layer.succeed(
  RipgrepBinary.Service,
  RipgrepBinary.Service.of({ filepath: Effect.die(new Error("thrown while downloading")) }),
)

const withTmp = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const write = (file: string, content: string | Buffer) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })

const it = testEffect(LayerNode.compile(Ripgrep.node, [[RipgrepBinary.node, missing]]))
const itCrash = testEffect(LayerNode.compile(Ripgrep.node, [[RipgrepBinary.node, crashing]]))

describe("Ripgrep built-in search hardening", () => {
  itCrash.live("falls back when the binary service dies instead of failing", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(path.join(dir, "a.txt"), "needle\n")
        const matches = yield* (yield* Ripgrep.Service).grep({ cwd: dir, pattern: "needle", limit: 10 })
        expect(matches.map((m) => String(m.entry.path))).toEqual(["a.txt"])
        const files = yield* (yield* Ripgrep.Service).find({ cwd: dir, pattern: "*", limit: 10 })
        expect(files.map((f) => String(f.path))).toEqual(["a.txt"])
      }),
    ),
  )

  it.live("honours nested .gitignore files", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(path.join(dir, "pkg", ".gitignore"), "secret.txt\n*.log\n")
        yield* write(path.join(dir, "pkg", "secret.txt"), "needle\n")
        yield* write(path.join(dir, "pkg", "x.log"), "needle\n")
        yield* write(path.join(dir, "pkg", "keep.txt"), "needle\n")
        yield* write(path.join(dir, "other", "secret.txt"), "needle\n")
        const matches = yield* (yield* Ripgrep.Service).grep({ cwd: dir, pattern: "needle", limit: 20 })
        expect(matches.map((m) => String(m.entry.path)).sort()).toEqual(["other/secret.txt", "pkg/keep.txt"])
      }),
    ),
  )

  it.live("skips binary files and files above the size cap", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        yield* write(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("needle")]))
        yield* write(path.join(dir, "big.txt"), "needle\n" + "x".repeat(3 * 1024 * 1024))
        yield* write(path.join(dir, "ok.txt"), "needle\n")
        const matches = yield* (yield* Ripgrep.Service).grep({ cwd: dir, pattern: "needle", limit: 20 })
        expect(matches.map((m) => String(m.entry.path))).toEqual(["ok.txt"])
      }),
    ),
  )

  it.live("never follows symlinks out of the project and stops at the result limit", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() => tmpdir())
        yield* write(path.join(outside.path, "leak.txt"), "needle\n")
        yield* write(path.join(dir, "in.txt"), "needle\nneedle\nneedle\n")
        yield* Effect.promise(async () => {
          await fs.symlink(outside.path, path.join(dir, "linkdir"), "dir").catch(() => {})
          await fs.symlink(path.join(outside.path, "leak.txt"), path.join(dir, "linkfile.txt")).catch(() => {})
          await fs.symlink(dir, path.join(dir, "loop"), "dir").catch(() => {})
        })
        const rg = yield* Ripgrep.Service
        const all = yield* rg.grep({ cwd: dir, pattern: "needle", limit: 50 })
        expect(all.map((m) => String(m.entry.path))).toEqual(["in.txt", "in.txt", "in.txt"])
        const found = yield* rg.find({ cwd: dir, pattern: "*", limit: 50, follow: true })
        expect(found.map((f) => String(f.path)).filter((p) => p.includes("leak") || p.startsWith("loop"))).toEqual([])
        const capped = yield* rg.grep({ cwd: dir, pattern: "needle", limit: 2 })
        expect(capped.length).toBe(2)
        yield* Effect.promise(() => outside[Symbol.asyncDispose]())
      }),
    ),
  )

  it.live("refuses to read a single file outside the project", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() => tmpdir())
        yield* write(path.join(outside.path, "leak.txt"), "needle\n")
        const matches = yield* (yield* Ripgrep.Service).grep({
          cwd: dir,
          pattern: "needle",
          file: path.join(outside.path, "leak.txt"),
          limit: 10,
        })
        expect(matches).toEqual([])
        yield* Effect.promise(() => outside[Symbol.asyncDispose]())
      }),
    ),
  )
})
