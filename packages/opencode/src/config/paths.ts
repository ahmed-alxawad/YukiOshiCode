export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import * as Effect from "effect/Effect"
import { FSUtil } from "@yukioshi/core/fs-util"

export type DirectoryScope = "global" | "project" | "explicit"
export type DirectoryEntry = { path: string; scope: DirectoryScope }

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string | readonly string[],
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const names = typeof name === "string" ? [name] : [...name]
  return (yield* afs.up({
    targets: names.toReversed().flatMap((item) => [`${item}.jsonc`, `${item}.json`]),
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directoryEntries = Effect.fn("ConfigPaths.directoryEntries")(function* (
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const project = !Flag.YUKIOSHI_DISABLE_PROJECT_CONFIG
    ? yield* afs.up({
        targets: [".opencode", ".yukioshi"],
        start: directory,
        stop: worktree,
      })
    : []
  const home = yield* afs.up({
    targets: [".opencode", ".yukioshi"],
    start: Global.Path.home,
    stop: Global.Path.home,
  })
  const pluginGlob = (cwd: string) =>
    afs
      .glob("plugins/*/.yukioshi-plugin.json", {
        cwd,
        absolute: true,
        dot: true,
      })
      .pipe(
        Effect.map((files) => files.map((file) => path.dirname(file))),
        Effect.catch(() => Effect.succeed([] as string[])),
      )
  const pluginDirs = yield* pluginGlob(Global.Path.config)
  const explicitPluginDirs = Flag.YUKIOSHI_CONFIG_DIR ? yield* pluginGlob(Flag.YUKIOSHI_CONFIG_DIR) : []
  const candidates: DirectoryEntry[] = [
    { path: Global.Path.config, scope: "global" },
    ...pluginDirs.map((dir): DirectoryEntry => ({ path: dir, scope: "global" })),
    ...explicitPluginDirs.map((dir): DirectoryEntry => ({ path: dir, scope: "explicit" })),
    ...project.map((path): DirectoryEntry => ({ path, scope: "project" })),
    ...home.map((path): DirectoryEntry => ({ path, scope: "global" })),
    ...(Flag.YUKIOSHI_CONFIG_DIR ? [{ path: Flag.YUKIOSHI_CONFIG_DIR, scope: "explicit" as const }] : []),
  ]
  const seen = new Set<string>()
  return candidates.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  return (yield* directoryEntries(directory, worktree)).map((entry) => entry.path)
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
