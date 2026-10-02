export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@yukioshi/core/fs-util"

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

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.YUKIOSHI_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode", ".yukioshi"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode", ".yukioshi"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.YUKIOSHI_CONFIG_DIR ? [Flag.YUKIOSHI_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
