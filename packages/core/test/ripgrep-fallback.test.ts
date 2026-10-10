import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { RipgrepBinary } from "@yukioshi/core/ripgrep/binary"
import { RelativePath } from "@yukioshi/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const failingBinaryLayer = Layer.succeed(
  RipgrepBinary.Service,
  RipgrepBinary.Service.of({
    filepath: Effect.fail(new Error("simulated ripgrep missing or failed download")),
  }),
)

const it = testEffect(LayerNode.compile(Ripgrep.node, [[RipgrepBinary.node, failingBinaryLayer]]))

describe("Ripgrep Pure-JS Fallback", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata and respects limits and callbacks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))

          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10, hidden: true })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            hidden: true,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(limited.length).toBe(1)
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))

          const globbed = yield* ripgrep.glob({ cwd: tmp.path, pattern: "config", limit: 10, hidden: true })
          expect(globbed.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(globbed.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("extracts submatches, line numbers, and offsets accurately in grep", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const content = "line 1: hello\nline 2: target and target again\nline 3: bye\n"
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "sample.txt"), content))

          const matches = yield* (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "target", limit: 10 })
          expect(matches.length).toBe(1)
          const match = matches[0]!
          expect(match.line).toBe(2)
          // "line 1: hello\n" = 14 bytes
          expect(match.offset).toBe(14)
          expect(match.text).toBe("line 2: target and target again")
          expect(match.submatches.length).toBe(2)
          expect(match.submatches[0]).toEqual({ text: "target", start: 8, end: 14 })
          expect(match.submatches[1]).toEqual({ text: "target", start: 19, end: 25 })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
          })

          expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns InvalidPatternError on unparseable regex in pure-JS fallback", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "test.txt"), "hello world\n"))

          const result = yield* (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "[invalid(", limit: 10 }).pipe(
            Effect.flip,
          )

          expect(result._tag).toBe("Ripgrep.InvalidPatternError")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("validates redirect hosts for ripgrep downloads", () =>
    Effect.sync(() => {
      expect(RipgrepBinary.isAllowedHost(new URL("https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/file.tar.gz"))).toBe(true)
      expect(RipgrepBinary.isAllowedHost(new URL("https://objects.githubusercontent.com/github-production-release-asset-2e65be/123"))).toBe(true)
      expect(RipgrepBinary.isAllowedHost(new URL("https://release-assets.githubusercontent.com/456"))).toBe(true)

      // Disallowed hosts
      expect(RipgrepBinary.isAllowedHost(new URL("https://malicious.example.com/file.tar.gz"))).toBe(false)
      expect(RipgrepBinary.isAllowedHost(new URL("http://github.com/file.tar.gz"))).toBe(false) // non-https
      expect(RipgrepBinary.isAllowedHost(new URL("https://github.com.attacker.com/file.tar.gz"))).toBe(false)
    }),
  )

  it.live("has pinned SHA-256 hashes for all 7 supported platforms", () =>
    Effect.sync(() => {
      const keys = [
        "arm64-darwin",
        "x64-darwin",
        "arm64-linux",
        "x64-linux",
        "arm64-win32",
        "ia32-win32",
        "x64-win32",
      ] as const

      for (const key of keys) {
        const config = RipgrepBinary.PLATFORM[key]
        expect(config).toBeDefined()
        expect(config.sha256).toMatch(/^[a-f0-9]{64}$/)
      }
    }),
  )
})
