import os from "os"
import path from "path"
import { realpathSync } from "fs"
import { ConfigMarkdown } from "./markdown"
import * as ProjectTrust from "../project/trust"

export interface ExternalRefOptions {
  platform?: NodeJS.Platform
  /** Path module matching the platform; path.win32 lets the Windows rules run anywhere. */
  pathModule?: path.PlatformPath
  home?: string
  /** Real path of an existing target; throws when it does not exist. */
  realpath?: (target: string) => string
  canonical?: (target: string) => string
}

/**
 * Whether a command template attaches (@path) a file outside the project roots. A name that does not
 * exist attaches nothing (it can only resolve to an agent), so it is not a reference.
 */
export function referencesOutsideProject(
  template: string,
  roots: { directory: string; worktree: string },
  options: ExternalRefOptions = {},
) {
  const platform = options.platform ?? process.platform
  const p = options.pathModule ?? (platform === "win32" ? path.win32 : path)
  const home = options.home ?? os.homedir()
  const realpath = options.realpath ?? ((target: string) => realpathSync.native(target))
  const canonical = options.canonical ?? ProjectTrust.canonical
  const bases = [...new Set([roots.worktree, roots.directory])]
  const canonicalRoots = [roots.directory, ...(roots.worktree === "/" ? [] : [roots.worktree])].map(canonical)
  // Windows compares paths case-insensitively and relative() reports another drive or a UNC share as absolute.
  const inside = (target: string) =>
    canonicalRoots.some((root) => {
      const rel = p.relative(root, target)
      return rel === "" || (!p.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${p.sep}`))
    })
  return ConfigMarkdown.files(template).some((match) => {
    const name = match[1]
    if (!name) return false
    // "~/" is home (also "~\" on Windows); the prompt resolves other names against the worktree
    // ("/" outside a repository, so try the directory too).
    const homeRef = name.startsWith("~/") || (platform === "win32" && name.startsWith("~\\"))
    const targets = homeRef ? [p.join(home, name.slice(2))] : bases.map((base) => p.resolve(base, name))
    return targets.some((target) => {
      try {
        return !inside(canonical(realpath(target)))
      } catch {
        return false
      }
    })
  })
}
