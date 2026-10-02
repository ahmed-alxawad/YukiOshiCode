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
  /^\.env(\..+)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pgpass$/,
  /^credentials(\.json)?$/,
  /^id_rsa(\.pub)?$/,
  /^id_ed25519(\.pub)?$/,
  /^id_ecdsa(\.pub)?$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keychain(-db)?$/,
  /^shadow$/,
]

function isProtectedPath(resource: string): boolean {
  const normalized = resource.replace(/\\/g, "/")
  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => PROTECTED_PATH_SEGMENTS.has(segment))) return true
  const base = segments[segments.length - 1] ?? normalized
  return PROTECTED_FILE_NAMES.some((pattern) => pattern.test(base))
}

// Unconditionally destructive shell commands: irreversible bulk deletion,
// disk-level destruction, fork bombs, and force-pushes/branch deletion of
// protected branches. Deliberately conservative (false negatives over
// false positives) - this is a backstop, not the primary review mechanism.
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*[rf]\w*\s+)*-\w*[rf]\w*\s+(\/|~\/?|\*|\.\s*$|\$HOME\b)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+[^|;&]*of=\/dev\/(disk|[sh]d|nvme)/i,
  />\s*\/dev\/(disk|[sh]d|nvme)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bgit\s+push\s+[^|;&]*--force(-with-lease)?\b[^|;&]*\b(origin\s+)?(main|master|trunk)\b/i,
  /\bgit\s+branch\s+-D\s+(main|master|trunk)\b/i,
  /\bchmod\s+-R\s+000\s+\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
]

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command))
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
