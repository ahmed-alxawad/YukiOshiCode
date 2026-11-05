// Environment for child processes (shell tool, PTY, LSP, MCP, git, ...). It is built explicitly from the
// parent environment minus launch credentials, so a child never sees the desktop token even while it is
// still present in the parent's process.env (and the initial /proc/<pid>/environ block is not the source).
export const LAUNCH_SECRET_NAMES = ["KOTHORA_DESKTOP_TOKEN", "YUKIOSHI_SERVER_PASSWORD", "YUKIOSHI_SERVER_USERNAME"] as const

export function childEnv(
  extra: Record<string, string | undefined> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const source of [base, extra]) {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) env[name] = value
    }
  }
  for (const name of Object.keys(env)) {
    if (LAUNCH_SECRET_NAMES.some((secret) => secret.toLowerCase() === name.toLowerCase())) delete env[name]
  }
  return env
}
