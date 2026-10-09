import { describe, expect, test } from "bun:test"
import { Redact } from "../src/redact"

const GH = "ghp_123456789012345678901234567890123456"
const AWS = "AKIAIOSFODNN7EXAMPLE"
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"

describe("redact edge cases", () => {
  test("empty input and options are returned untouched", () => {
    expect(Redact.maskWithReport("")).toEqual({ text: "", masked: false, count: 0, matches: [] })
    expect(Redact.mask("nothing secret here")).toBe("nothing secret here")
    expect(Redact.findSecrets("plain")).toEqual([])
  })

  test("masking is idempotent and never re-redacts a placeholder", () => {
    const once = Redact.mask(`token=${GH}\npassword=hunter22\n${AWS}`)
    expect(once).not.toContain(GH)
    expect(Redact.mask(once)).toBe(once)
    expect(Redact.maskWithReport(once).count).toBe(0)
  })

  test("reports each match with kind, value and placeholder", () => {
    const report = Redact.maskWithReport(`${AWS} and ${GH}`)
    expect(report.masked).toBe(true)
    expect(report.count).toBe(2)
    expect(report.matches).toEqual([
      { kind: "github-token", value: GH, placeholder: "[REDACTED:github-token]" },
      { kind: "aws-key", value: AWS, placeholder: "[REDACTED:aws-key]" },
    ])
  })

  test("AWS and GitHub tokens need word boundaries", () => {
    expect(Redact.mask(`x${AWS}x`)).toBe(`x${AWS}x`)
    expect(Redact.mask(`${AWS}Z`)).toBe(`${AWS}Z`)
    expect(Redact.mask(`(${AWS})`)).toBe("([REDACTED:aws-key])")
    expect(Redact.mask("ghp_" + "a".repeat(80))).toBe("ghp_" + "a".repeat(80))
    expect(Redact.mask("ASIA" + "B".repeat(16))).toBe("[REDACTED:aws-key]")
  })

  test("aws secret key assignment keeps its prefix and quotes", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    expect(Redact.mask(`aws_secret_access_key = "${secret}"`)).toBe(
      'aws_secret_access_key = "[REDACTED:aws-secret-key]"',
    )
    expect(Redact.mask(`AWS_SECRET_KEY=${secret}`)).toBe("AWS_SECRET_KEY=[REDACTED:aws-secret-key]")
    // 39 characters is not an AWS secret key, but the generic secret rule still hides it
    const short = Redact.maskWithReport(`aws_secret_access_key=${secret.slice(1)}`)
    expect(short.matches.map((m) => m.kind)).toEqual(["secret"])
    expect(short.text).not.toContain(secret.slice(1))
  })

  test("redacts every private key block, whatever the algorithm, including multi-line bodies", () => {
    const block = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----\nMIIE\nabc+/=\n-----END ${kind}PRIVATE KEY-----`
    const text = `a\n${block("RSA ")}\nmiddle\n${block("")}\n${block("EC ")}\nz`
    expect(Redact.mask(text)).toBe(
      "a\n[REDACTED:private-key]\nmiddle\n[REDACTED:private-key]\n[REDACTED:private-key]\nz",
    )
    expect(Redact.mask(block("OPENSSH "))).toBe("[REDACTED:private-key]")
  })

  test("a public key block is left alone", () => {
    const pub = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
    expect(Redact.mask(pub)).toBe(pub)
  })

  test("JWTs are redacted inside headers and json, but two-segment look-alikes are not", () => {
    expect(Redact.mask(`Authorization: ${JWT}`)).toBe("Authorization: [REDACTED:jwt]")
    expect(Redact.mask(`{"jwt":"${JWT}"}`)).toBe('{"jwt":"[REDACTED:jwt]"}')
    const twoSegments = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    expect(Redact.mask(twoSegments)).toBe(twoSegments)
  })

  describe("env assignments", () => {
    test("handles export, quotes, colon syntax and a trailing comment", () => {
      expect(Redact.mask("export DB_PASSWORD='hunter2hunter2' # prod")).toBe(
        "export DB_PASSWORD='[REDACTED:password]' # prod",
      )
      expect(Redact.mask("api_token: abcd1234")).toBe("api_token: [REDACTED:token]")
      expect(Redact.mask("CLIENT_SECRET=abcdefgh")).toBe("CLIENT_SECRET=[REDACTED:secret]")
      expect(Redact.mask("MY_PASSWD=abcdefgh")).toBe("MY_PASSWD=[REDACTED:password]")
    })

    test("works with CRLF line endings and only redacts matching lines", () => {
      expect(Redact.mask("A=1\r\nSECRET=abcdefgh\r\nB=2\r\n")).toBe("A=1\r\nSECRET=[REDACTED:secret]\r\nB=2\r\n")
    })

    test("indented assignments are redacted", () => {
      expect(Redact.mask("  \tpassword=abcdef")).toBe("  \tpassword=[REDACTED:password]")
    })

    test("values shorter than four characters are not treated as secrets", () => {
      expect(Redact.mask("password=abc")).toBe("password=abc")
      expect(Redact.mask("password=abcd")).toBe("password=[REDACTED:password]")
    })

    test("an unrelated variable name is not touched", () => {
      expect(Redact.mask("PORT=3000\nNAME=somevalue")).toBe("PORT=3000\nNAME=somevalue")
    })

    test("unicode values are redacted up to the first space", () => {
      expect(Redact.mask("PASSWORD=pässwörd-ünï rest")).toBe("PASSWORD=[REDACTED:password] rest")
    })
  })

  test("unicode and emoji text without secrets is untouched", () => {
    const text = "日本語のテキスト 🎉 токен пароль café\n".repeat(50)
    expect(Redact.mask(text)).toBe(text)
  })

  describe("config options", () => {
    test("allow list only exempts exact secret values", () => {
      const other = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
      expect(Redact.mask(`${GH} ${other}`, { allow: [GH] })).toBe(`${GH} [REDACTED:github-token]`)
    })

    test("allow list applies to the value of an env secret", () => {
      expect(Redact.mask("token=abcd1234", { allow: ["abcd1234"] })).toBe("token=abcd1234")
    })

    test("invalid custom patterns are skipped instead of throwing", () => {
      expect(() => Redact.mask("hello CUSTOM-1", { patterns: ["(", "CUSTOM-\\d"] })).not.toThrow()
      expect(Redact.mask("hello CUSTOM-1", { patterns: ["(", "CUSTOM-\\d"] })).toBe("hello [REDACTED:custom]")
    })

    test("custom patterns run even when no built-in hint is present, and honour the allow list", () => {
      const result = Redact.maskWithReport("id ZZ-1 ZZ-2", { patterns: ["ZZ-\\d"], allow: ["ZZ-2"] })
      expect(result.text).toBe("id [REDACTED:custom] ZZ-2")
      expect(result.count).toBe(1)
    })

    test("enabled false disables everything", () => {
      expect(Redact.mask(GH, { enabled: false, patterns: [".*"] })).toBe(GH)
    })
  })

  describe("resolveEdit", () => {
    test("returns inputs unchanged when there are no placeholders", () => {
      expect(Redact.resolveEdit(`k=${GH}`, "a", "b")).toEqual({ oldString: "a", newString: "b" })
    })

    test("leaves placeholders alone when the file has no secrets", () => {
      const r = Redact.resolveEdit("nothing", "[REDACTED:token]", "[REDACTED:token]")
      expect(r).toEqual({ oldString: "[REDACTED:token]", newString: "[REDACTED:token]" })
    })

    test("restores several occurrences of one placeholder", () => {
      const r = Redact.resolveEdit(
        `a=${GH}`,
        "[REDACTED:github-token] [REDACTED:github-token]",
        "[REDACTED:github-token]!",
      )
      expect(r.oldString).toBe(`${GH} ${GH}`)
      expect(r.newString).toBe(`${GH}!`)
    })
  })

  describe("scrubKnown", () => {
    test("empty text and registration of non-strings or short values", () => {
      Redact.registerSecret(undefined)
      Redact.registerSecret(12345678)
      expect(Redact.scrubKnown("")).toBe("")
      expect(Redact.scrubKnown("12345678")).toBe("12345678")
    })

    test("only rewrites Bearer values that look like tokens", () => {
      expect(Redact.scrubKnown("Bearer short")).toBe("Bearer short")
      expect(Redact.scrubKnown("a Bearer abcdefghijklmnop.qrst-uv b")).toBe("a Bearer [REDACTED:bearer-token] b")
    })
  })

  describe("adversarial input", () => {
    const fast = (text: string, ms = 2000) => {
      const start = performance.now()
      Redact.mask(text)
      expect(performance.now() - start).toBeLessThan(ms)
    }

    test("a long run of blank lines does not blow up (quadratic backtracking)", () => {
      fast("\n".repeat(100_000) + "token")
    })

    test("long blank-line and whitespace runs in other shapes stay fast", () => {
      fast("\r\n".repeat(100_000) + "token")
      fast("\n ".repeat(100_000) + "token")
      fast(" \t".repeat(50_000) + "password=abcdef")
    })

    test("long runs that almost match a rule stay fast", () => {
      fast("-----BEGIN PRIVATE KEY-----" + "A".repeat(500_000))
      fast("eyJ" + "a".repeat(500_000))
      fast("sk-" + "a".repeat(500_000))
      fast("ghp_" + "a".repeat(500_000))
      fast("password=" + " ".repeat(500_000))
      fast("token ".repeat(100_000))
    })

    test("secrets are still found inside a multi megabyte input", () => {
      const filler = "const value = compute(1, 2, 3)\n".repeat(60_000)
      const out = Redact.mask(`${filler}key=${AWS}\n${filler}`)
      expect(out).not.toContain(AWS)
      expect(out).toContain("[REDACTED:aws-key]")
    })
  })
})
