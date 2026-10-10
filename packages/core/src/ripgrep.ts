export * as Ripgrep from "./ripgrep"

import nodeFs from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "node:path"
import ignore from "ignore"
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@yukioshi/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    let warned = false
    const warnFallback = (cause?: unknown) =>
      Effect.sync(() => {
        if (!warned) {
          warned = true
          console.warn("yukioshi: ripgrep binary is not available; falling back to built-in search")
        }
      }).pipe(
        Effect.flatMap(() =>
          Effect.logWarning("ripgrep binary is not available; falling back to built-in search", { error: cause }),
        ),
      )

    const matchesGlob = (pattern: string, relPath: string): boolean => {
      if (pattern === "*" || pattern === "**/*") return true
      const norm = relPath.replaceAll("\\", "/")
      const basename = path.basename(norm)
      if (!pattern.includes("/")) {
        if (new Bun.Glob(pattern).match(basename)) return true
      }
      return new Bun.Glob(pattern).match(norm) || new Bun.Glob(`**/${pattern}`).match(norm)
    }

    const loadGitignore = async (cwd: string) => {
      const ig = ignore().add(".git")
      try {
        const content = await nodeFs.readFile(path.join(cwd, ".gitignore"), "utf8")
        ig.add(
          content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#")),
        )
      } catch {
        // No .gitignore, ignore
      }
      return ig
    }

    async function* walk(
      cwd: string,
      dir: string,
      options: { hidden?: boolean; follow?: boolean; signal?: AbortSignal; ig: ReturnType<typeof ignore> },
    ): AsyncGenerator<{ relPath: string; fullPath: string }> {
      if (options.signal?.aborted) return

      let entries: Dirent[]
      try {
        entries = await nodeFs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const dirent of entries) {
        if (options.signal?.aborted) return
        const name = dirent.name
        if (name === ".git") continue
        if (!options.hidden && name.startsWith(".")) continue

        const fullPath = path.join(dir, name)
        const relPath = path.relative(cwd, fullPath).replaceAll("\\", "/")

        if (dirent.isDirectory()) {
          if (options.ig.ignores(relPath + "/") || options.ig.ignores(relPath)) continue
          yield* walk(cwd, fullPath, options)
        } else if (dirent.isFile()) {
          if (options.ig.ignores(relPath)) continue
          yield { relPath, fullPath }
        } else if (dirent.isSymbolicLink() && options.follow) {
          try {
            const stat = await nodeFs.stat(fullPath)
            if (stat.isDirectory()) {
              if (options.ig.ignores(relPath + "/") || options.ig.ignores(relPath)) continue
              yield* walk(cwd, fullPath, options)
            } else if (stat.isFile()) {
              if (options.ig.ignores(relPath)) continue
              yield { relPath, fullPath }
            }
          } catch {
            // broken link
          }
        }
      }
    }

    const fallbackFind = (input: FindInput) =>
      Effect.gen(function* () {
        const ig = yield* Effect.promise(() => loadGitignore(input.cwd))
        const results: Entry[] = []
        const walker = walk(input.cwd, input.cwd, {
          hidden: input.hidden,
          follow: input.follow,
          signal: input.signal,
          ig,
        })
        while (true) {
          const next = yield* Effect.promise(() => walker.next())
          if (next.done) break
          if (input.signal?.aborted) break
          const { relPath } = next.value
          if (matchesGlob(input.pattern, relPath)) {
            const entry = Entry.make({
              path: RelativePath.make(relPath),
              type: "file",
            })
            if (input.onEntry && results.length < input.limit) {
              yield* input.onEntry(entry)
            }
            results.push(entry)
            if (results.length >= input.limit) break
          }
        }
        return results
      })

    const fallbackGlob = (input: GlobInput) =>
      Effect.gen(function* () {
        const ig = yield* Effect.promise(() => loadGitignore(input.cwd))
        const results: Entry[] = []
        const walker = walk(input.cwd, input.cwd, {
          hidden: input.hidden,
          follow: input.follow,
          signal: input.signal,
          ig,
        })
        while (true) {
          const next = yield* Effect.promise(() => walker.next())
          if (next.done) break
          if (input.signal?.aborted) break
          const { relPath } = next.value
          if (matchesGlob(input.pattern, relPath)) {
            results.push(
              Entry.make({
                path: RelativePath.make(relPath),
                type: "file",
              }),
            )
            if (results.length >= input.limit) break
          }
        }
        return results
      })

    const isBinaryBuffer = (buf: Buffer) => {
      const len = Math.min(buf.length, 8192)
      for (let i = 0; i < len; i++) {
        if (buf[i] === 0) return true
      }
      return false
    }

    const fallbackGrep = (input: GrepInput) =>
      Effect.gen(function* () {
        let regex: RegExp
        try {
          regex = new RegExp(input.pattern, "gd")
        } catch (e: any) {
          return yield* new InvalidPatternError({ pattern: input.pattern, message: e?.message ?? String(e) })
        }

        const matches: Match[] = []

        const searchFile = function* (relPath: string, fullPath: string) {
          let contentBuffer: Buffer
          try {
            contentBuffer = yield* Effect.promise(() => nodeFs.readFile(fullPath))
          } catch {
            return
          }
          if (isBinaryBuffer(contentBuffer)) return

          const text = contentBuffer.toString("utf8")
          const lines = text.split(/\r?\n/)
          let offset = 0

          for (let i = 0; i < lines.length; i++) {
            if (input.signal?.aborted || matches.length >= input.limit) break
            const line = lines[i]!
            regex.lastIndex = 0
            const submatches: { text: string; start: number; end: number }[] = []
            let match: RegExpExecArray | null

            while ((match = regex.exec(line)) !== null) {
              const start = match.indices ? match.indices[0]![0] : match.index
              const end = match.indices ? match.indices[0]![1] : match.index + match[0].length
              submatches.push({ text: match[0], start, end })
              if (submatches.length >= MAX_SUBMATCHES) break
              if (match[0].length === 0) {
                regex.lastIndex++
              }
            }

            if (submatches.length > 0) {
              const preview =
                line.length > 2000 ? line.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "") + "..." : line
              matches.push(
                Match.make({
                  entry: Entry.make({
                    path: RelativePath.make(relPath),
                    type: "file",
                  }),
                  line: i + 1,
                  offset,
                  text: preview,
                  submatches,
                }),
              )
            }

            offset += Buffer.byteLength(line, "utf8") + 1
          }
        }

        if (input.file) {
          const fullPath = path.resolve(input.cwd, input.file)
          const relPath = path.relative(input.cwd, fullPath).replaceAll("\\", "/")
          yield* searchFile(relPath, fullPath)
          return matches
        }

        const ig = yield* Effect.promise(() => loadGitignore(input.cwd))
        const walker = walk(input.cwd, input.cwd, {
          hidden: true,
          follow: false,
          signal: input.signal,
          ig,
        })

        while (true) {
          const next = yield* Effect.promise(() => walker.next())
          if (next.done) break
          if (input.signal?.aborted || matches.length >= input.limit) break
          const { relPath, fullPath } = next.value
          if (input.include && !matchesGlob(input.include, relPath)) continue
          yield* searchFile(relPath, fullPath)
        }

        return matches
      })

    let ripgrepUnavailable = false

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) => {
        if (ripgrepUnavailable) return fallbackGlob(input)
        return run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
          Effect.catch((cause) => {
            ripgrepUnavailable = true
            return warnFallback(cause).pipe(Effect.flatMap(() => fallbackGlob(input)))
          }),
        )
      },
      find: (input) => {
        if (ripgrepUnavailable) return fallbackFind(input)
        return run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
          Effect.catch((cause) => {
            ripgrepUnavailable = true
            return warnFallback(cause).pipe(Effect.flatMap(() => fallbackFind(input)))
          }),
        )
      },
      grep: (input) => {
        if (ripgrepUnavailable) return fallbackGrep(input)
        return run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text:
                  match.lines.text.length > 2_000
                    ? match.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                    : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
          Effect.catch((cause) => {
            if (cause instanceof InvalidPatternError) {
              return Effect.fail(cause)
            }
            ripgrepUnavailable = true
            return warnFallback(cause).pipe(Effect.flatMap(() => fallbackGrep(input)))
          }),
        )
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
