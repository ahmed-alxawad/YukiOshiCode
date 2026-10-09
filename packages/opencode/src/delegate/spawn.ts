import path from "path"

// Pure helpers for starting a delegated agent portably. The platform is a parameter so the Windows rules
// can be tested on any host.

type Env = Record<string, string | undefined>

function lookup(env: Env, name: string) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** Merge env maps; on Windows keys are case-insensitive, so `Path` and `PATH` are one variable (last wins). */
export function mergeEnv(platform: NodeJS.Platform, ...layers: Env[]): Record<string, string> {
  const result: Record<string, string> = {}
  const names = new Map<string, string>()
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      if (platform !== "win32") {
        result[key] = value
        continue
      }
      const upper = key.toUpperCase()
      const previous = names.get(upper)
      if (previous !== undefined && previous !== key) delete result[previous]
      names.set(upper, key)
      result[key] = value
    }
  }
  return result
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

export interface ResolveOptions {
  platform: NodeJS.Platform
  env: Env
  cwd: string
  exists: (file: string) => boolean
}

/**
 * Find the real file a command name refers to. On Windows this walks PATH with each PATHEXT extension, so an
 * npm-installed `agent.cmd` shim is found; elsewhere the command is returned unchanged (the OS resolves it).
 */
export function resolveCommand(cmd: string, options: ResolveOptions): string {
  if (options.platform !== "win32") return cmd
  const win = path.win32
  const exts = (lookup(options.env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
  const hasExt = (file: string) => exts.some((e) => file.toLowerCase().endsWith(e.toLowerCase()))
  const withDir = /[\\/]/.test(cmd) || win.isAbsolute(cmd)
  const dirs = withDir ? [""] : [options.cwd, ...(lookup(options.env, "PATH") ?? "").split(";").filter(Boolean)]
  for (const dir of dirs) {
    const base = withDir ? win.resolve(options.cwd, cmd) : win.join(dir.replace(/^"|"$/g, ""), cmd)
    const candidates = hasExt(base) ? [base] : exts.map((e) => base + e)
    for (const file of candidates) {
      if (options.exists(file)) return file
    }
  }
  return cmd
}

export function isCmdScript(file: string) {
  return /\.(cmd|bat)$/i.test(file)
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Quote one argument for cmd.exe (MSVCRT rules, then caret-escape cmd's metacharacters). */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  if (/[\r\n\0]/.test(arg)) throw new Error("Agent command arguments cannot contain line breaks or NUL.")
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")
  out = `"${out}"`
  out = out.replace(CMD_META, "^$1")
  if (doubleEscape) out = out.replace(CMD_META, "^$1")
  return out
}

export interface SpawnPlan {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** What to pass to child_process.spawn: .cmd/.bat shims cannot be spawned directly, they go through cmd.exe. */
export function planSpawn(cmd: string, args: string[], options: ResolveOptions): SpawnPlan {
  const resolved = resolveCommand(cmd, options)
  if (options.platform !== "win32" || !isCmdScript(resolved)) return { command: resolved, args }
  const line = [quoteCmdArg(resolved), ...args.map((a) => quoteCmdArg(a, true))].join(" ")
  const shell = lookup(options.env, "COMSPEC") || "cmd.exe"
  return { command: shell, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true }
}
