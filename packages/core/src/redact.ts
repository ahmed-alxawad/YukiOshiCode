export * as Redact from "./redact"

import { ConfigRedactV1 } from "./v1/config/redact"

export interface RedactionMatch {
  kind: string
  value: string
  placeholder: string
}

export interface RedactionResult {
  text: string
  masked: boolean
  count: number
  matches: RedactionMatch[]
}

const QUICK_HINT =
  /(?:gh[posur]_|github_pat_|A[KS]IA|AWS_SECRET|aws_secret|sk-|AIza|xox|xapp-|_live_|glpat-|hf_|npm_|SG\.|-----BEGIN|eyJ|password|passwd|pass|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|accountkey|authorization|:\/\/|\s-[up])/i

const PLACEHOLDER_PREFIX = "[REDACTED:"
const PLACEHOLDER_REGEX = /\[REDACTED:([a-zA-Z0-9_-]+)\]/g

interface PatternRule {
  kind: string | ((keyMatch: string) => string)
  regex: RegExp
  extractValue?: (match: RegExpExecArray) => { value: string; fullMatch: string; prefix?: string; suffix?: string }
}

function secretKind(keyStr: string): string {
  const lower = keyStr.toLowerCase()
  if (lower.includes("password") || lower.includes("passwd")) return "password"
  if (lower.includes("secret")) return "secret"
  if (lower.includes("token")) return "token"
  return "env-secret"
}

// Key names whose value is a secret. Used for quoted JSON keys and for maskDeep's object keys.
const SECRET_KEY_WORDS =
  "[A-Za-z0-9_-]{0,60}(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|accountkey|authorization)[A-Za-z0-9_-]{0,60}"
const SECRET_KEY = new RegExp(`^(?:${SECRET_KEY_WORDS})$`, "i")

const RULES: PatternRule[] = [
  // GitHub tokens
  {
    kind: "github-token",
    regex:
      /\b(ghp_[A-Za-z0-9]{30,40}|gho_[A-Za-z0-9]{30,40}|ghu_[A-Za-z0-9]{30,40}|ghs_[A-Za-z0-9]{30,40}|ghr_[A-Za-z0-9]{30,40}|github_pat_[A-Za-z0-9_]{60,100})\b/g,
  },
  // AWS Access Key ID
  {
    kind: "aws-key",
    regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  },
  // AWS Secret Access Key in KEY=value form
  {
    kind: "aws-secret-key",
    regex:
      /\b((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_secret_key|AWS_SECRET_KEY)\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(["']?)/g,
    extractValue: (m) => ({
      value: m[2]!,
      fullMatch: m[0]!,
      prefix: m[1]!,
      suffix: m[3]!,
    }),
  },
  // Anthropic API keys
  {
    kind: "anthropic-key",
    regex: /(?<![a-zA-Z0-9_-])(sk-ant-[A-Za-z0-9_-]{20,})/g,
  },
  // OpenAI API keys
  {
    kind: "openai-key",
    regex: /(?<![a-zA-Z0-9_-])(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})(?![a-zA-Z0-9_-])/g,
  },
  // Google API keys
  {
    kind: "google-key",
    regex: /\b(AIza[0-9A-Za-z-_]{30,40})\b/g,
  },
  // Slack tokens
  {
    kind: "slack-token",
    regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
  },
  // Stripe live keys (sk_live_, rk_live_)
  {
    kind: "stripe-key",
    regex: /\b((?:sk|rk)_live_[0-9a-zA-Z]{24,})\b/g,
  },
  // Private key blocks
  {
    kind: "private-key",
    // A block with no END line (truncated output) is masked through the end of the input.
    regex: /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|[\s\S]*))/g,
  },
  // Credentials embedded in URLs (scheme://user:password@host): mask the password only
  {
    kind: "url-credentials",
    regex: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/?#]{0,256}:)(?![$<{]|\[REDACTED:)([^\s/?#]{1,2000})(@)/gi,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]!, suffix: m[3]! }),
  },
  // JWT tokens
  {
    kind: "jwt",
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  // Env assignments (password=, secret=, token=)
  {
    kind: (keyStr: string) => {
      const lower = keyStr.toLowerCase()
      if (lower.includes("password") || lower.includes("passwd")) return "password"
      if (lower.includes("secret")) return "secret"
      if (lower.includes("token")) return "token"
      return "env-secret"
    },
    regex:
      /(?<=^|[\r\n])([ \t]*(?:export[ \t]+)?([A-Za-z0-9_]{0,60}(?:password|passwd|_pass|pwd|secret|token|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_]{0,60})\s*[:=]\s*["']?)(?![\[]REDACTED:)([^#\r\n"'\s]{4,})(["']?)/gi,
    extractValue: (m) => ({
      value: m[3]!,
      fullMatch: m[0]!,
      prefix: m[1]!,
      suffix: m[4]!,
    }),
  },
  // Env-style assignments that are not at the start of a line (`export X=...`, `FOO=1 TOKEN=...`
  // inside a command line), including quoted values. Requires `=` so prose is left alone.
  {
    kind: (keyStr: string) => secretKind(keyStr),
    regex:
      /(?<![A-Za-z0-9_.-])(([A-Za-z0-9_]{0,60}(?:password|passwd|_pass|pwd|secret|token|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_]{0,60})[ \t]*=[ \t]*)(?:"(?![$]|\[REDACTED:)([^"\r\n]{4,})"|'(?![$]|\[REDACTED:)([^'\r\n]{4,})'|(?![$"'`]|\[REDACTED:)([^\s"'`#;&|<>]{4,}))/gi,
    extractValue: (m) => {
      const quote = m[3] !== undefined ? '"' : m[4] !== undefined ? "'" : ""
      return { value: (m[3] ?? m[4] ?? m[5])!, fullMatch: m[0]!, prefix: m[1]! + quote, suffix: quote }
    },
  },
  // CLI flags carrying a secret: --token=abc, --password abc, --api-key "abc"
  {
    kind: (keyStr: string) => secretKind(keyStr),
    regex:
      /(?<![A-Za-z0-9_-])(--([a-z0-9-]{0,40}(?:password|passwd|secret|token|api-?key|credential)[a-z0-9-]{0,40})(?:=|[ \t]+)["']?)(?![$-]|\[REDACTED:)([^\s"'`#;&|<>]{4,})(["']?)/gi,
    extractValue: (m) => ({ value: m[3]!, fullMatch: m[0]!, prefix: m[1]!, suffix: m[4]! }),
  },
  // More provider token formats: GitLab, Hugging Face, npm, SendGrid, Slack app tokens
  {
    kind: "token",
    regex:
      /(?<![A-Za-z0-9_-])(glpat-[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|xapp-[0-9A-Za-z-]{20,})(?![A-Za-z0-9_-])/g,
  },
  // JSON-style quoted keys: "password": "...", "SecretAccessKey": "...", "api_key":"..."
  {
    kind: (keyStr: string) => secretKind(keyStr),
    regex: new RegExp(
      `("(${SECRET_KEY_WORDS})"\\s*:\\s*")(?!\\[REDACTED:)((?:[^"\\\\\\r\\n]|\\\\.){4,})(")`,
      "gi",
    ),
    extractValue: (m) => ({ value: m[3]!, fullMatch: m[0]!, prefix: m[1]!, suffix: m[4]! }),
  },
  // HTTP auth headers: Authorization: Basic/Bearer/Token <x>, X-Api-Key: <x>, X-Auth-Token: <x>
  {
    kind: "token",
    regex:
      /\b((?:authorization|proxy-authorization)[ \t]*:[ \t]*(?:basic|bearer|token|digest)?[ \t]*|x-[a-z0-9-]{0,30}(?:key|token|secret)[ \t]*:[ \t]*)(?!\[REDACTED:)([A-Za-z0-9._~+/=:-]{8,})/gi,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]! }),
  },
  // Passwords on command lines: curl -u user:pw, sshpass -p pw, mysql -ppw, docker login -p pw
  {
    kind: "password",
    regex:
      /((?:^|[\s;&|(])(?:-u|--user)[ \t=]+["']?[^\s:"']{1,100}:)(?!\[REDACTED:)([^\s"']{3,})/g,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]! }),
  },
  {
    kind: "password",
    regex: /(\b(?:sshpass|docker[ \t]+login|podman[ \t]+login)\b[^\r\n]{0,200}?[ \t]-p[ \t]*["']?)(?![-$]|\[REDACTED:)([^\s"']{3,})/g,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]! }),
  },
  {
    kind: "password",
    regex: /(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^\r\n]{0,200}?[ \t]-p)(?![ \t-]|\[REDACTED:)([^\s"']{3,})/g,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]! }),
  },
  // Azure storage connection strings: AccountKey=...
  {
    kind: "secret",
    regex: /(\bAccountKey=)(?!\[REDACTED:)([A-Za-z0-9+/=]{20,})/g,
    extractValue: (m) => ({ value: m[2]!, fullMatch: m[0]!, prefix: m[1]! }),
  },
]

/**
 * Scan and mask secrets in the given text.
 */
export function maskWithReport(text: string, options?: ConfigRedactV1.Info): RedactionResult {
  if (!text || options?.enabled === false) {
    return { text, masked: false, count: 0, matches: [] }
  }

  const allowSet = options?.allow?.length ? new Set(options.allow) : null
  const customPatterns = options?.patterns?.length
    ? options.patterns.map((p) => {
        try {
          return new RegExp(p, "g")
        } catch {
          return null
        }
      }).filter((r): r is RegExp => r !== null)
    : []

  // Fast path: if no custom patterns and text doesn't contain any hint
  if (customPatterns.length === 0 && !QUICK_HINT.test(text)) {
    return { text, masked: false, count: 0, matches: [] }
  }

  let result = text
  let count = 0
  const matches: RedactionMatch[] = []

  // Run standard rules
  for (const rule of RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags)
    result = result.replace(regex, (fullMatch, ...args) => {
      // Don't redact existing placeholders
      if (fullMatch.startsWith(PLACEHOLDER_PREFIX)) {
        return fullMatch
      }

      let secretValue = fullMatch
      let prefix = ""
      let suffix = ""
      let kind = typeof rule.kind === "function" ? rule.kind(fullMatch) : rule.kind

      if (rule.extractValue) {
        // Re-run regex.exec on fullMatch to extract groups reliably
        const singleRegex = new RegExp(rule.regex.source, rule.regex.flags.replace("g", ""))
        const m = singleRegex.exec(fullMatch)
        if (m) {
          const extracted = rule.extractValue(m)
          secretValue = extracted.value
          prefix = extracted.prefix ?? ""
          suffix = extracted.suffix ?? ""
          if (typeof rule.kind === "function" && m[2]) {
            kind = rule.kind(m[2])
          }
        }
      } else {
        // The first capturing group is the secret value
        if (typeof args[0] === "string" && args[0].length > 0) {
          secretValue = args[0]
        }
      }

      if (allowSet && allowSet.has(secretValue)) {
        return fullMatch
      }

      const placeholder = `${PLACEHOLDER_PREFIX}${kind}]`
      count++
      matches.push({ kind, value: secretValue, placeholder })
      return prefix + placeholder + suffix
    })
  }

  // Run custom user-defined patterns
  for (const pat of customPatterns) {
    const regex = new RegExp(pat.source, pat.flags)
    result = result.replace(regex, (fullMatch) => {
      if (fullMatch.startsWith(PLACEHOLDER_PREFIX)) {
        return fullMatch
      }
      if (allowSet && allowSet.has(fullMatch)) {
        return fullMatch
      }
      const kind = "custom"
      const placeholder = `${PLACEHOLDER_PREFIX}${kind}]`
      count++
      matches.push({ kind, value: fullMatch, placeholder })
      return placeholder
    })
  }

  return {
    text: result,
    masked: count > 0,
    count,
    matches,
  }
}

/**
 * Mask secrets in string and return redacted string.
 */
export function mask(text: string, options?: ConfigRedactV1.Info): string {
  return maskWithReport(text, options).text
}

/**
 * Mask secrets in every string of a JSON-like value (objects, arrays, strings), returning a copy.
 * Keys, numbers and other values are left alone. Used for payloads that leave the machine or reach disk.
 */
function allowed(value: string, options?: ConfigRedactV1.Info) {
  return options?.enabled === false || (options?.allow?.includes(value) ?? false) || value.startsWith(PLACEHOLDER_PREFIX)
}

export function maskDeep<T>(value: T, options?: ConfigRedactV1.Info): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return scrubKnown(mask(item, options))
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item)))
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [
          key,
          // A string under a secret-looking key is a secret whatever its shape ({ password: "hunter2" }).
          typeof entry === "string" && entry.length >= 4 && SECRET_KEY.test(key) && !allowed(entry, options)
            ? `${PLACEHOLDER_PREFIX}${secretKind(key)}]`
            : walk(entry),
        ]),
      )
    return item
  }
  return walk(value) as T
}

/**
 * Extract all secrets from text without modifying it.
 */
export function findSecrets(text: string, options?: ConfigRedactV1.Info): RedactionMatch[] {
  return maskWithReport(text, options).matches
}

/**
 * Reconcile oldString and newString for file editing when secrets were redacted.
 * - Replaces placeholders in oldString with the actual secret from contentOld.
 * - Restores actual secrets into newString so [REDACTED:...] placeholders are NEVER written back to disk.
 */
export function resolveEdit(
  contentOld: string,
  oldString: string,
  newString: string,
  options?: ConfigRedactV1.Info,
): { oldString: string; newString: string } {
  // If neither oldString nor newString has placeholders, nothing to unredact
  if (!oldString.includes(PLACEHOLDER_PREFIX) && !newString.includes(PLACEHOLDER_PREFIX)) {
    return { oldString, newString }
  }

  const secrets = findSecrets(contentOld, options)
  if (secrets.length === 0) {
    return { oldString, newString }
  }

  let resolvedOld = oldString
  let resolvedNew = newString

  // Map placeholders to real secret values found in contentOld
  for (const secret of secrets) {
    if (resolvedOld.includes(secret.placeholder)) {
      resolvedOld = resolvedOld.replaceAll(secret.placeholder, secret.value)
    }
    if (resolvedNew.includes(secret.placeholder)) {
      resolvedNew = resolvedNew.replaceAll(secret.placeholder, secret.value)
    }
  }

  // Fallback: If oldString or newString still contains any [REDACTED:<kind>]
  // match by kind from available secrets in contentOld
  if (resolvedOld.includes(PLACEHOLDER_PREFIX) || resolvedNew.includes(PLACEHOLDER_PREFIX)) {
    for (const secret of secrets) {
      const genericPlaceholder = `${PLACEHOLDER_PREFIX}${secret.kind}]`
      if (resolvedOld.includes(genericPlaceholder)) {
        resolvedOld = resolvedOld.replaceAll(genericPlaceholder, secret.value)
      }
      if (resolvedNew.includes(genericPlaceholder)) {
        resolvedNew = resolvedNew.replaceAll(genericPlaceholder, secret.value)
      }
    }
  }

  return { oldString: resolvedOld, newString: resolvedNew }
}

const knownSecrets = new Set<string>()
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g

/**
 * Remember a credential that is in use (a provider API key). The value is then
 * replaced wherever scrubKnown() is applied, even when it matches none of the
 * format rules above (for example a custom gateway key).
 */
export function registerSecret(value: unknown): void {
  if (typeof value === "string" && value.length >= 8) knownSecrets.add(value)
}

/**
 * Replace every registered credential and any `Bearer <token>` in text.
 * Used for logs and error text, where a provider may echo the request headers.
 */
export function scrubKnown(text: string): string {
  if (!text) return text
  let result = text
  for (const secret of knownSecrets) {
    if (result.includes(secret)) result = result.split(secret).join(`${PLACEHOLDER_PREFIX}provider-key]`)
  }
  if (result.includes("Bearer")) result = result.replace(BEARER, `$1${PLACEHOLDER_PREFIX}bearer-token]`)
  return result
}

const PROVIDER_CREDENTIAL_PLACEHOLDER = `${PLACEHOLDER_PREFIX}provider-key]`
const providerSecrets = new Set<string>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function isProviderCredentialReference(value: string): boolean {
  return /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value)
}

function isProviderCredentialPlaceholder(value: unknown): value is string {
  return value === PROVIDER_CREDENTIAL_PLACEHOLDER
}

function isProviderCredentialKey(key: string, providerEntry: boolean): boolean {
  const normalized = key.toLowerCase().replaceAll(/[_-]/g, "")
  if (providerEntry && normalized === "key") return true
  if (normalized === "authorization" || normalized === "proxyauthorization") return true
  if (normalized === "apikey" || normalized === "apikeys" || normalized.endsWith("apikey")) return true
  if (normalized === "token" || normalized.endsWith("token") || normalized.endsWith("tokens")) return true
  if (normalized === "secret" || normalized.endsWith("secret") || normalized === "secretaccesskey") return true
  if (normalized === "password" || normalized.endsWith("password")) return true
  if (normalized === "credential" || normalized.endsWith("credential") || normalized.endsWith("credentials"))
    return true
  return normalized === "accesskey"
}

function isProviderEntry(value: Record<string, unknown>): boolean {
  return "models" in value
}

function rememberProviderCredential(value: string): void {
  if (!value || isProviderCredentialPlaceholder(value) || isProviderCredentialReference(value)) return
  providerSecrets.add(value)
  registerSecret(value)
  const bearer = /^Bearer\s+(.+)$/i.exec(value)
  if (!bearer?.[1]) return
  providerSecrets.add(bearer[1])
  registerSecret(bearer[1])
}

function registerProviderCredentialValue(value: unknown): void {
  if (typeof value === "string") {
    rememberProviderCredential(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) registerProviderCredentialValue(item)
    return
  }
  registerProviderCredentialFields(value)
}

function registerProviderCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) registerProviderCredentialFields(item)
    return
  }
  if (!isPlainRecord(value)) return
  const providerEntry = isProviderEntry(value)
  for (const [key, item] of Object.entries(value)) {
    if (isProviderCredentialKey(key, providerEntry)) registerProviderCredentialValue(item)
    else registerProviderCredentialFields(item)
  }
}

function maskProviderCredentialValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value || isProviderCredentialPlaceholder(value) || isProviderCredentialReference(value)) return value
    rememberProviderCredential(value)
    return PROVIDER_CREDENTIAL_PLACEHOLDER
  }
  if (Array.isArray(value)) return value.map(maskProviderCredentialValue)
  return maskProviderCredentialFields(value)
}

function maskProviderCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskProviderCredentialFields)
  if (!isPlainRecord(value)) return value
  const providerEntry = isProviderEntry(value)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isProviderCredentialKey(key, providerEntry)
        ? maskProviderCredentialValue(item)
        : maskProviderCredentialFields(item),
    ]),
  )
}

function restoreProviderCredentialValue(current: unknown, next: unknown): unknown {
  if (isProviderCredentialPlaceholder(next)) {
    if (typeof current === "string" && !isProviderCredentialPlaceholder(current)) {
      rememberProviderCredential(current)
      return current
    }
    return next
  }
  if (Array.isArray(next)) {
    return next.map((item, index) =>
      restoreProviderCredentialValue(Array.isArray(current) ? current[index] : undefined, item),
    )
  }
  return restoreProviderCredentialFields(current, next)
}

function restoreProviderCredentialFields(current: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    return next.map((item, index) =>
      restoreProviderCredentialFields(Array.isArray(current) ? current[index] : undefined, item),
    )
  }
  if (!isPlainRecord(next)) return next
  const previous = isPlainRecord(current) ? current : {}
  const providerEntry = isProviderEntry(next)
  return Object.fromEntries(
    Object.entries(next).map(([key, item]) => [
      key,
      isProviderCredentialKey(key, providerEntry)
        ? restoreProviderCredentialValue(previous[key], item)
        : restoreProviderCredentialFields(previous[key], item),
    ]),
  )
}

function scrubRegisteredProviderCredentials(text: string): string {
  if (!text) return text
  let result = text
  const secrets = new Set([...knownSecrets, ...providerSecrets])
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (result.includes(secret)) result = result.split(secret).join(PROVIDER_CREDENTIAL_PLACEHOLDER)
  }
  return result
}

/**
 * Remember credential-bearing fields from provider configuration or public provider information.
 * This intentionally does not inspect arbitrary text or unrelated configuration sections.
 */
export function registerProviderCredentials(value: unknown): void {
  registerProviderCredentialFields(value)
}

/**
 * Mask credential-bearing fields from provider configuration or public provider information.
 * Unlike maskDeep(), arbitrary text is preserved so callers can keep user-authored content intact.
 */
export function maskProviderCredentials<T>(value: T): T {
  return maskProviderCredentialFields(value) as T
}

/**
 * Restore real provider credentials when a client sends back a response placeholder during a config update.
 */
export function restoreProviderCredentials<T>(current: unknown, next: T): T {
  return restoreProviderCredentialFields(current, next) as T
}

/**
 * Replace only registered provider credentials in a response payload. This is deliberately narrower than maskDeep().
 */
export function maskRegisteredProviderCredentialsDeep<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return scrubRegisteredProviderCredentials(item)
    if (Array.isArray(item)) return item.map(walk)
    if (isPlainRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]))
    return item
  }
  return walk(value) as T
}
