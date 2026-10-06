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
  /(?:gh[posur]_|github_pat_|A[KS]IA|AWS_SECRET|aws_secret|sk-|AIza|xox|_live_|-----BEGIN|eyJ|password|passwd|secret|token)/i

const PLACEHOLDER_PREFIX = "[REDACTED:"
const PLACEHOLDER_REGEX = /\[REDACTED:([a-zA-Z0-9_-]+)\]/g

interface PatternRule {
  kind: string | ((keyMatch: string) => string)
  regex: RegExp
  extractValue?: (match: RegExpExecArray) => { value: string; fullMatch: string; prefix?: string; suffix?: string }
}

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
    regex: /(-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----)/g,
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
      /(?<=^|[\r\n])(\s*(?:export\s+)?([A-Za-z0-9_]*(?:password|passwd|secret|token)[A-Za-z0-9_]*)\s*[:=]\s*["']?)(?![\[]REDACTED:)([^#\r\n"'\s]{4,})(["']?)/gi,
    extractValue: (m) => ({
      value: m[3]!,
      fullMatch: m[0]!,
      prefix: m[1]!,
      suffix: m[4]!,
    }),
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
