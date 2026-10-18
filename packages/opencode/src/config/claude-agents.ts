import path from "path"

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
