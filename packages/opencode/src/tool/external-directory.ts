import path from "path"
import { realpathSync } from "fs"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@yukioshi/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

/** Real path of the deepest existing ancestor, with the missing tail re-attached. */
function realTarget(target: string): string {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      // native resolves Windows 8.3 short names and macOS /var -> /private/var alike
      return path.join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

const foldCase = process.platform === "win32" || process.platform === "darwin"

function inside(root: string, child: string) {
  return foldCase ? FSUtil.contains(root.toLowerCase(), child.toLowerCase()) : FSUtil.contains(root, child)
}

/** The project directory always counts; the worktree only when there is one (non-git projects use "/"). */
function insideRealProject(real: string, ins: { directory: string; worktree: string }) {
  if (inside(realTarget(ins.directory), real)) return true
  if (ins.worktree === "/") return false
  return inside(realTarget(ins.worktree), real)
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  let full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  // Judge the place the path really lands on: a symlink inside the project can point anywhere, and a path
  // spelled through a symlinked parent (macOS /var -> /private/var) can still be inside it.
  const real = realTarget(full)
  if (insideRealProject(real, ins)) return false
  if (containsPath(full, ins)) full = real

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
