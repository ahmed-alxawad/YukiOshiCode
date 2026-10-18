import path from "path"
import { existsSync } from "fs"

// Where Claude-style agent directories slot into the config-merge order of
// `Config.directories()`: after the user's own config dir (and its plugin dirs) and before
// project dirs, so precedence is .yukioshi/.opencode > .claude > global. Shared by config
// loading and `agent validate`/`agent show` so duplicate reporting matches the real winner.
export function claudeInsertIndex(directories: string[], globalConfig: string) {
  let index = 0
  while (index < directories.length && directories[index]!.startsWith(globalConfig)) index++
  return index
}

export function withClaudeDirs(directories: string[], claude: string[], globalConfig: string) {
  const extra = claude.filter((dir) => !directories.includes(dir))
  const at = claudeInsertIndex(directories, globalConfig)
  return [...directories.slice(0, at), ...extra, ...directories.slice(at)]
}

export const isClaudeDir = (dir: string) => path.basename(dir) === ".claude"

// Upper bound for the project `.claude` search. A non-git project reports the filesystem root
// as its worktree; never walk up to it, stay inside the project directory instead.
export function claudeProjectStop(directory: string, worktree?: string) {
  if (!worktree || worktree === path.parse(worktree).root) return directory
  return worktree
}

// Same boundary without an Instance: the nearest ancestor with a `.git`, else the directory itself.
export function claudeProjectRoot(directory: string) {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return directory
  }
}
