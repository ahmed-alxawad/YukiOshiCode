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
      return path.join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function realContext(ins: { directory: string; worktree: string }) {
  const real = (dir: string) => (dir === "/" ? dir : realTarget(dir))
  return { directory: real(ins.directory), worktree: real(ins.worktree) } as Parameters<typeof containsPath>[1]
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
  if (containsPath(full, ins)) {
    // A symlink inside the project can point anywhere. Judge the place the path really lands on.
    const real = realTarget(full)
    if (containsPath(real, realContext(ins))) return false
    full = real
  }

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
