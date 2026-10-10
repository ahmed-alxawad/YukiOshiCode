export * as SafetyGuards from "./guards"

/**
 * Hard safety blocks, ported from YukiOshi Code's own permission model.
 *
 * These run before any configured ruleset (agent.permissions, saved
 * approvals, or a session's permission mode) is consulted, and their
 * verdict cannot be overridden by a rule, a saved "always allow", or
 * auto/auto-all mode. They exist to stop a handful of unconditionally
 * dangerous actions even when a user has configured (or a mode grants)
 * blanket allow rules.
 */

export interface Verdict {
  readonly reason: string
}

const PROTECTED_PATH_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube"])

const PROTECTED_FILE_NAMES = [
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pgpass$/,
  /^credentials(\.json)?$/,
  /^application_default_credentials\.json$/,
  /^id_rsa(\.pub)?$/,
  /^id_ed25519(\.pub)?$/,
  /^id_ecdsa(\.pub)?$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keychain(-db)?$/,
  /^shadow$/,
]

const ENV_FILE = /^\.env(?:\..+)?$/
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/

const SHELL_STARTUP_FILE_NAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  "microsoft.powershell_profile.ps1",
])

function isOutsideProject(resource: string): boolean {
  const normalized = resource.replace(/\\/g, "/")
  const relative = normalized.replace(/^(?:\.\/)+/, "")
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-z]:\//i.test(normalized) ||
    relative === ".." ||
    relative.startsWith("../")
  )
}

function isShellStartupPath(normalized: string, segments: string[]): boolean {
  if (!isOutsideProject(normalized)) return false
  const base = (segments[segments.length - 1] ?? normalized).toLowerCase()
  if (SHELL_STARTUP_FILE_NAMES.has(base)) return true
  return normalized.toLowerCase().endsWith("/fish/config.fish")
}

// Google Cloud CLI sign-ins (including YukiOshi's "Sign in with Google" for Vertex AI) keep
// refresh tokens for the whole Google Cloud account here.
function isGcloudCredentialPath(segments: string[]): boolean {
  const index = segments.findIndex((segment) => segment.toLowerCase() === "gcloud")
  if (index === -1) return false
  const rest = segments.slice(index + 1)
  if (rest[0] === "legacy_credentials") return true
  return rest.length === 1 && /^(?:credentials|access_tokens)\.db$/.test(rest[0]!)
}

// Windows and macOS resolve names case-insensitively, and Windows drops trailing dots and
// spaces (`.ssh.` and `.SSH ` are `.ssh`), so compare on a canonical form of each segment.
function canonicalSegment(segment: string): string {
  if (/^\.+$/.test(segment)) return segment
  return segment.replace(/[. ]+$/, "").toLowerCase()
}

function isProtectedPath(resource: string): boolean {
  const normalized = resource.replace(/\\/g, "/")
  const segments = normalized.split("/").map(canonicalSegment).filter(Boolean)
  if (segments.some((segment) => PROTECTED_PATH_SEGMENTS.has(segment))) return true
  const base = segments[segments.length - 1] ?? normalized
  if (ENV_FILE.test(base)) return !ENV_TEMPLATE.test(base)
  if (PROTECTED_FILE_NAMES.some((pattern) => pattern.test(base))) return true
  if (isGcloudCredentialPath(segments)) return true
  return isShellStartupPath(normalized, segments)
}

// Unconditionally destructive shell commands: irreversible bulk deletion,
// disk-level destruction, fork bombs, and force-pushes/branch deletion of
// protected branches. Deliberately conservative (false negatives over
// false positives) - this is a backstop, not the primary review mechanism.
interface ShellWord {
  readonly value: string
  readonly plain: boolean
  /** Part of the word was single-quoted, so `$` inside it does not expand. */
  readonly singleQuoted: boolean
}

type ShellCommand = ShellWord[]

function shellCommands(source: string): ShellCommand[] {
  const commands: ShellCommand[] = []

  function parse(start: number, terminator?: ")" | "`"): number {
    let index = start
    let words: ShellWord[] = []
    let value = ""
    let plain = true
    let singleQuoted = false
    let started = false
    let quote: "'" | '"' | undefined

    const finishWord = () => {
      if (!started) return
      words.push({ value, plain, singleQuoted })
      value = ""
      plain = true
      singleQuoted = false
      started = false
    }

    const finishCommand = () => {
      finishWord()
      if (words.length > 0) commands.push(words)
      words = []
    }

    while (index < source.length) {
      const char = source[index]

      if (quote === "'") {
        if (char === "'") {
          quote = undefined
        } else {
          value += char
        }
        index++
        continue
      }

      if (quote === '"') {
        if (char === '"') {
          quote = undefined
          index++
          continue
        }
        if (char === "\\") {
          if (index + 1 < source.length) value += source[index + 1]
          plain = false
          started = true
          index += 2
          continue
        }
        if (char === "$" && source[index + 1] === "(") {
          plain = false
          started = true
          index = parse(index + 2, ")")
          continue
        }
        if (char === "`") {
          plain = false
          started = true
          index = parse(index + 1, "`")
          continue
        }
        value += char
        plain = false
        started = true
        index++
        continue
      }

      if (terminator && char === terminator) {
        finishCommand()
        return index + 1
      }
      if (char === "'" || char === '"') {
        quote = char
        if (char === "'") singleQuoted = true
        plain = false
        started = true
        index++
        continue
      }
      if (char === "\\") {
        if (index + 1 < source.length) value += source[index + 1]
        plain = false
        started = true
        index += 2
        continue
      }
      if (char === "$" && source[index + 1] === "(") {
        plain = false
        started = true
        index = parse(index + 2, ")")
        continue
      }
      if (char === "`") {
        plain = false
        started = true
        index = parse(index + 1, "`")
        continue
      }
      if (char === "\n") {
        finishCommand()
        index++
        continue
      }
      if (/\s/.test(char)) {
        finishWord()
        index++
        continue
      }
      if (char === ";" || char === "|" || char === "&") {
        finishCommand()
        if (source[index + 1] === char) index++
        index++
        continue
      }

      value += char
      started = true
      index++
    }

    finishCommand()
    return index
  }

  parse(0)
  return commands
}

const SUDO_OPTIONS_WITH_ARGUMENT = new Set([
  "-C",
  "-D",
  "-R",
  "-T",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-u",
  "-U",
  "--chdir",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
])

const SUDO_SHORT_OPTIONS_WITH_ARGUMENT = new Set(["C", "D", "R", "T", "g", "h", "p", "r", "t", "u", "U"])

function sudoCommandIndex(words: ShellCommand): number | undefined {
  let index = 1
  while (index < words.length) {
    const option = words[index].value
    if (option === "--") return index + 1 < words.length ? index + 1 : undefined
    if (!option.startsWith("-") || option === "-") return index

    const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option
    if (SUDO_OPTIONS_WITH_ARGUMENT.has(name) && !option.includes("=")) {
      index += 2
      continue
    }

    if (!option.startsWith("--")) {
      const flags = option.slice(1)
      const argumentAt = [...flags].findIndex((flag) => SUDO_SHORT_OPTIONS_WITH_ARGUMENT.has(flag))
      if (argumentAt === flags.length - 1) {
        index += 2
        continue
      }
    }
    index++
  }
  return undefined
}

function programName(word: ShellWord | undefined): string | undefined {
  if (!word) return undefined
  return word.value.replace(/\\/g, "/").split("/").pop()?.toLowerCase()
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Wrappers that run the next word as a program without changing what it does.
const TRANSPARENT_WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice"])

function executable(command: ShellCommand): { name: string; index: number } | undefined {
  let index = 0
  // Leading `VAR=value` assignments and transparent wrappers do not change the real program.
  for (let guard = 0; guard < 16 && index < command.length; guard++) {
    const word = command[index].value
    if (ASSIGNMENT.test(word)) {
      index++
      continue
    }
    const wrapper = programName(command[index])
    if (wrapper === "sudo") {
      const sudoIndex = sudoCommandIndex(command.slice(index))
      if (sudoIndex === undefined) return undefined
      index += sudoIndex
      continue
    }
    if (wrapper && TRANSPARENT_WRAPPERS.has(wrapper)) {
      index++
      while (index < command.length && (command[index].value.startsWith("-") || ASSIGNMENT.test(command[index].value)))
        index++
      continue
    }
    break
  }
  const name = programName(command[index])
  return name ? { name, index } : undefined
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const POWER_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff"])
const DANGEROUS_RM_LITERAL_TARGETS = new Set(["/", ".", "./"])
const DANGEROUS_RM_EXPANDING_TARGETS = new Set(["/*", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "*"])
// `$HOME` still expands inside double quotes, unlike `~` and globs.
const DANGEROUS_RM_HOME_TARGETS = new Set(["$HOME", "${HOME}", "$HOME/", "${HOME}/"])

function isDangerousRm(command: ShellCommand, programIndex: number): boolean {
  let destructiveFlag = false
  let parseOptions = true
  const targets: ShellWord[] = []

  for (const word of command.slice(programIndex + 1)) {
    const value = word.value
    if (parseOptions && value === "--") {
      parseOptions = false
      continue
    }
    if (parseOptions && value.startsWith("--")) {
      if (value === "--recursive" || value === "--force") destructiveFlag = true
      continue
    }
    if (parseOptions && /^-[^-]/.test(value)) {
      if (/[rRf]/.test(value.slice(1))) destructiveFlag = true
      continue
    }
    targets.push(word)
  }

  if (!destructiveFlag) return false
  return targets.some((target) => {
    // `//`, `/.` and `/./` all name the filesystem root.
    const value = /^\/(?:\.?\/)*\.?$/.test(target.value) ? "/" : target.value
    return (
      DANGEROUS_RM_LITERAL_TARGETS.has(value) ||
      (target.plain && DANGEROUS_RM_EXPANDING_TARGETS.has(value)) ||
      (!target.singleQuoted && DANGEROUS_RM_HOME_TARGETS.has(value))
    )
  })
}

function isProtectedBranch(value: string): boolean {
  return /(?:^|[:/])(main|master|trunk)$/i.test(value)
}

function isDestructiveGit(command: ShellCommand, programIndex: number): boolean {
  const args = command.slice(programIndex + 1).map((word) => word.value)
  // Skip git's global options (`git -C dir push ...`, `git -c k=v push ...`).
  while (args.length > 0 && args[0].startsWith("-")) {
    const takesValue = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[0])
    args.splice(0, takesValue ? 2 : 1)
  }
  if (args[0] === "push") {
    // `-f`, `--force`, `--force-with-lease`, or a `+branch` refspec all force the update.
    const forced = args.some((arg) => /^--force(?:-with-lease)?(?:=|$)/.test(arg) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg))
    if (args.some((arg) => arg.startsWith("+") && isProtectedBranch(arg.slice(1)))) return true
    return forced && args.some(isProtectedBranch)
  }
  if (args[0] === "branch") {
    return args.includes("-D") && args.some(isProtectedBranch)
  }
  return false
}

function isDestructiveChmod(command: ShellCommand, programIndex: number): boolean {
  const args = command.slice(programIndex + 1).map((word) => word.value)
  return (args.includes("-R") || args.includes("--recursive")) && args.includes("000") && args.includes("/")
}

function unquotedShellText(source: string): string {
  let quote: "'" | '"' | undefined
  let result = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = undefined
      result += " "
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      result += " "
      continue
    }
    if (char === "\\") {
      result += " "
      if (index + 1 < source.length) {
        result += " "
        index++
      }
      continue
    }
    result += char
  }
  return result
}

function isDestructiveCommand(command: string): boolean {
  for (const shellCommand of shellCommands(command)) {
    const program = executable(shellCommand)
    if (!program) continue
    if (POWER_COMMANDS.has(program.name)) return true
    if (SHELLS.has(program.name)) {
      const rest = shellCommand.slice(program.index + 1).map((word) => word.value)
      const flag = rest.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
      if (flag !== -1 && rest[flag + 1] !== undefined && isDestructiveCommand(rest[flag + 1])) return true
    }
    if (program.name === "rm" && isDangerousRm(shellCommand, program.index)) return true
    if (/^mkfs(?:\.|$)/.test(program.name)) return true
    if (
      program.name === "dd" &&
      shellCommand.slice(program.index + 1).some((word) => /^of=\/dev\/(?:disk|[sh]d|nvme)/i.test(word.value))
    )
      return true
    if (program.name === "git" && isDestructiveGit(shellCommand, program.index)) return true
    if (program.name === "chmod" && isDestructiveChmod(shellCommand, program.index)) return true
  }

  const syntax = unquotedShellText(command)
  return />\s*\/dev\/(?:disk|[sh]d|nvme)/i.test(syntax) || /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(syntax)
}

const PATH_ACTIONS = new Set(["read", "edit", "write", "apply_patch"])

export function check(action: string, resources: readonly string[]): Verdict | undefined {
  if (PATH_ACTIONS.has(action)) {
    for (const resource of resources) {
      if (isProtectedPath(resource)) {
        return { reason: `refusing to access protected path: ${resource}` }
      }
    }
  }
  if (action === "bash") {
    for (const resource of resources) {
      if (isDestructiveCommand(resource)) {
        return { reason: `refusing to run a destructive command: ${resource}` }
      }
    }
  }
  return undefined
}
