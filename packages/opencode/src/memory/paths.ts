// Git-root detection ported near-verbatim from Kilo Code's packages/kilo-memory/src/storage/paths.ts
// (MIT License); trimmed to the three source files this simplified port actually uses.
import { readFileSync, realpathSync, statSync } from "fs"
import { createHash } from "crypto"
import path from "path"
import { MemorySlug } from "./slug"
import type { MemorySchema } from "./schema"

export namespace MemoryPaths {
  export type Ctx = {
    directory: string
    worktree: string
  }

  export type Files = {
    root: string
    project: string
    environment: string
    corrections: string
  }

  function base(ctx: Ctx) {
    return ctx.worktree === "/" ? ctx.directory : ctx.worktree
  }

  function stat(file: string) {
    return statSync(file, { throwIfNoEntry: false })
  }

  function read(file: string) {
    try {
      return readFileSync(file, "utf8").trim()
    } catch {
      return undefined
    }
  }

  function checkout(dir: string) {
    return path.basename(dir) === ".git" ? path.dirname(dir) : undefined
  }

  function common(dir: string) {
    const text = read(path.join(dir, "commondir"))
    return text ? path.resolve(dir, text) : dir
  }

  function project(dir: string) {
    const dot = path.join(dir, ".git")
    const info = stat(dot)
    if (!info) return dir
    if (info.isDirectory()) return checkout(common(dot)) ?? dir
    if (!info.isFile()) return dir
    const text = read(dot)
    const match = text?.match(/^gitdir:\s*(.+)$/m)
    if (!match?.[1]) return dir
    const git = path.resolve(dir, match[1])
    if (!belongs(dot, git)) return dir
    return checkout(common(git)) ?? dir
  }

  function belongs(dot: string, git: string) {
    const back = read(path.join(git, "gitdir"))
    if (!back) return false
    return canon(path.resolve(git, back)) === canon(dot)
  }

  function canon(dir: string) {
    const resolved = path.resolve(dir)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }

  function identity(ctx: Ctx) {
    const root = canon(project(base(ctx)))
    const display = MemorySlug.safe(path.basename(root), { max: MemorySlug.max.label, fallback: "project" })
    const hash = createHash("sha1").update(root).digest("hex").slice(0, 12)
    return `${display}-${hash}`
  }

  export function root(ctx: Ctx, dataDir: string) {
    return path.join(dataDir, "memory", identity(ctx))
  }

  export function files(root: string): Files {
    return {
      root,
      project: path.join(root, "project.md"),
      environment: path.join(root, "environment.md"),
      corrections: path.join(root, "corrections.md"),
    }
  }

  export function source(root: string, name: MemorySchema.Source) {
    const paths = files(root)
    if (name === "project.md") return paths.project
    if (name === "environment.md") return paths.environment
    return paths.corrections
  }
}
