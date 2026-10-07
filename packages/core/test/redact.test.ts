import { describe, expect, test } from "bun:test"
import { Redact } from "../src/redact"

describe("secret redaction", () => {
  describe("pattern detection (true positives)", () => {
    test("redacts GitHub tokens", () => {
      const ghp = "ghp_123456789012345678901234567890123456"
      const gho = "gho_123456789012345678901234567890123456"
      const pat = "github_pat_11AAAAAAA0123456789012_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
      expect(Redact.mask(`token is ${ghp}`)).toBe("token is [REDACTED:github-token]")
      expect(Redact.mask(`token is ${gho}`)).toBe("token is [REDACTED:github-token]")
      expect(Redact.mask(`token is ${pat}`)).toBe("token is [REDACTED:github-token]")
    })

    test("redacts AWS access keys and secret keys", () => {
      const akia = "AKIAIOSFODNN7EXAMPLE"
      const asia = "ASIAIOSFODNN7EXAMPLE"
      expect(Redact.mask(`aws key ${akia}`)).toBe("aws key [REDACTED:aws-key]")
      expect(Redact.mask(`aws session key ${asia}`)).toBe("aws session key [REDACTED:aws-key]")

      const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
      expect(Redact.mask(`aws_secret_access_key = "${secret}"`)).toBe('aws_secret_access_key = "[REDACTED:aws-secret-key]"')
      expect(Redact.mask(`AWS_SECRET_KEY=${secret}`)).toBe("AWS_SECRET_KEY=[REDACTED:aws-secret-key]")
    })

    test("redacts OpenAI, Anthropic, and Google keys", () => {
      const oai = "sk-proj-abc12345678901234567890123456789012"
      const ant = "sk-ant-api03-123456789012345678901234"
      const goog = "AIzaSyD-123456789012345678901234567890"
      expect(Redact.mask(`api_key: ${oai}`)).toBe("api_key: [REDACTED:openai-key]")
      expect(Redact.mask(`api_key: ${ant}`)).toBe("api_key: [REDACTED:anthropic-key]")
      expect(Redact.mask(`api_key: ${goog}`)).toBe("api_key: [REDACTED:google-key]")
    })

    test("redacts Slack tokens", () => {
      const slack = "xoxb-123456789012-123456789012-abcdef123456"
      expect(Redact.mask(`slack token: ${slack}`)).toBe("slack token: [REDACTED:slack-token]")
    })

    test("redacts Stripe live keys", () => {
      const skLive = ["sk", "live", "51Abcdefghijklmnopqrstuvw"].join("_")
      const rkLive = ["rk", "live", "51Abcdefghijklmnopqrstuvw"].join("_")
      expect(Redact.mask(`stripe key: ${skLive}`)).toBe("stripe key: [REDACTED:stripe-key]")
      expect(Redact.mask(`stripe key: ${rkLive}`)).toBe("stripe key: [REDACTED:stripe-key]")
    })

    test("redacts private key blocks", () => {
      const privKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+
...some private key bytes...
-----END RSA PRIVATE KEY-----`
      expect(Redact.mask(`key:\n${privKey}`)).toBe("key:\n[REDACTED:private-key]")
    })

    test("redacts JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      expect(Redact.mask(`Authorization: Bearer ${jwt}`)).toBe("Authorization: Bearer [REDACTED:jwt]")
    })

    test("redacts env file assignments", () => {
      const env = `DB_PASSWORD="super_secret_db_pass_123"
API_SECRET=my_top_secret_key_456
ACCESS_TOKEN='my_access_token_789'`
      const masked = Redact.mask(env)
      expect(masked).toContain('DB_PASSWORD="[REDACTED:password]"')
      expect(masked).toContain("API_SECRET=[REDACTED:secret]")
      expect(masked).toContain("ACCESS_TOKEN='[REDACTED:token]'")
    })
  })

  describe("false positive safety (normal code untouched)", () => {
    test("does not match sk- inside unrelated words", () => {
      expect(Redact.mask("a risk-free guarantee for all users")).toBe("a risk-free guarantee for all users")
      expect(Redact.mask("run task-runner on startup")).toBe("run task-runner on startup")
      expect(Redact.mask("start flask-app service")).toBe("start flask-app service")
      expect(Redact.mask("sk-short")).toBe("sk-short")
    })

    test("does not match stripe test keys", () => {
      expect(Redact.mask("sk_test_51Abcdefghijklmnopqrstuvw")).toBe("sk_test_51Abcdefghijklmnopqrstuvw")
    })

    test("does not match short or malformed tokens", () => {
      expect(Redact.mask("ghp_short")).toBe("ghp_short")
      expect(Redact.mask("AKIA123")).toBe("AKIA123")
    })

    test("does not match regular code assignments", () => {
      const code = `const count = 42;
let name = "test";
export const port = 8080;`
      expect(Redact.mask(code)).toBe(code)
    })
  })

  describe("config options", () => {
    test("respects enabled: false", () => {
      const secret = "ghp_123456789012345678901234567890123456"
      expect(Redact.mask(`token: ${secret}`, { enabled: false })).toBe(`token: ${secret}`)
    })

    test("respects allow list", () => {
      const secret = "ghp_123456789012345678901234567890123456"
      const other = "ghp_999999999999999999999999999999999999"
      const text = `allowed: ${secret}, not allowed: ${other}`
      const masked = Redact.mask(text, { allow: [secret] })
      expect(masked).toContain(`allowed: ${secret}`)
      expect(masked).toContain("not allowed: [REDACTED:github-token]")
    })

    test("supports custom regex patterns", () => {
      const text = "internal-key: SECRET_CUSTOM_KEY_12345"
      const masked = Redact.mask(text, { patterns: ["SECRET_CUSTOM_[A-Z0-9_]+"] })
      expect(masked).toBe("internal-key: [REDACTED:custom]")
    })
  })

  describe("edit round-trip safety", () => {
    test("restores secrets when editing files so placeholder is never written to disk", () => {
      const secret = "ghp_123456789012345678901234567890123456"
      const fileContent = `export const GITHUB_TOKEN = "${secret}";
export const PORT = 3000;
`
      // Agent read the file and saw redacted version
      const oldString = `export const GITHUB_TOKEN = "[REDACTED:github-token]";
export const PORT = 3000;`
      const newString = `export const GITHUB_TOKEN = "[REDACTED:github-token]";
export const PORT = 8080;`

      const resolved = Redact.resolveEdit(fileContent, oldString, newString)
      // oldString matches actual content in file
      expect(resolved.oldString).toBe(`export const GITHUB_TOKEN = "${secret}";
export const PORT = 3000;`)
      // newString preserves the actual secret
      expect(resolved.newString).toBe(`export const GITHUB_TOKEN = "${secret}";
export const PORT = 8080;`)
      expect(resolved.newString).not.toContain("[REDACTED:")
    })
  })

  describe("benchmark", () => {
    test("processes 1 MB tool output in well under 50 ms", () => {
      const chunk = "function processData(value: number): number { return value * 2 + 1; }\n"
      // ~1.05 MB
      const text = chunk.repeat(15000)
      expect(text.length).toBeGreaterThan(1_000_000)

      // Warmup
      Redact.mask(text)

      // The fastest of a few runs, with room to spare: one slow run on a busy CI machine says nothing about
      // the code, while a pattern that backtracks badly takes far longer than this.
      let fastest = Infinity
      for (let run = 0; run < 5; run++) {
        const start = performance.now()
        const masked = Redact.mask(text)
        fastest = Math.min(fastest, performance.now() - start)
        expect(masked.length).toBe(text.length)
      }
      console.log(`\n=== Redaction 1 MB Benchmark ===`)
      console.log(`Processed ${text.length} characters in ${fastest.toFixed(3)} ms (fastest of 5)`)
      expect(fastest).toBeLessThan(50)
    })
  })
})
