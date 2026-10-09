import { describe, expect, test } from "bun:test"
import { Redact } from "../src/redact"

describe("redact inline env assignments and flags", () => {
  test("masks export statements and assignments inside a command line", () => {
    expect(Redact.mask("run: export API_KEY=abcd1234efgh")).toBe("run: export API_KEY=[REDACTED:env-secret]")
    expect(Redact.mask("FOO=bar TOKEN=abcd1234 node app.js")).toBe("FOO=bar TOKEN=[REDACTED:token] node app.js")
    expect(Redact.mask("cd x && DB_PASSWORD=hunter22 ./run")).toBe("cd x && DB_PASSWORD=[REDACTED:password] ./run")
  })

  test("masks quoted values, including spaces, and keeps the quotes", () => {
    expect(Redact.mask(`echo "x" ; MY_SECRET="correct horse battery" ls`)).toBe(
      `echo "x" ; MY_SECRET="[REDACTED:secret]" ls`,
    )
    expect(Redact.mask("env AUTH_TOKEN='abcd1234' cmd")).toBe("env AUTH_TOKEN='[REDACTED:token]' cmd")
  })

  test("masks secret flags in both = and space forms", () => {
    expect(Redact.mask("cli login --token=abcd1234 --verbose")).toBe("cli login --token=[REDACTED:token] --verbose")
    expect(Redact.mask("mysql --password hunter22 -u root")).toBe("mysql --password [REDACTED:password] -u root")
    expect(Redact.mask(`curl --api-key "abcd1234"`)).toBe(`curl --api-key "[REDACTED:env-secret]"`)
  })

  test("reports the real value", () => {
    expect(Redact.findSecrets("a TOKEN=abcd1234 b").map((m) => m.value)).toEqual(["abcd1234"])
  })

  test("is idempotent", () => {
    const once = Redact.mask("export API_KEY=abcd1234 --token=zzzz9999")
    expect(Redact.mask(once)).toBe(once)
  })

  test("does not over-redact ordinary text", () => {
    for (const t of [
      "PATH=/usr/bin:/bin node app.js",
      "export PATH=/usr/bin",
      "NODE_ENV=production bun run build",
      "The token expires after an hour, see the secret section",
      "note: token: expired for this user",
      "set the password to something strong",
      "use --token to authenticate",
      "cmd TOKEN=$TOKEN_FROM_ENV run",
      "cmd SECRET=${SECRET} run",
      "--password $PW",
      "--token --verbose",
      "KEY=value SORT_KEY=name",
      "monkey=bananas123",
      "cmd TOKEN=abc",
    ]) {
      expect(Redact.mask(t)).toBe(t)
    }
  })

  test("is linear on hostile input", () => {
    const inputs = [
      " ".repeat(100_000) + "TOKEN",
      "TOKEN".repeat(20_000),
      "TOKEN=".repeat(16_000),
      "a".repeat(100_000) + "token=",
      "token" + "_".repeat(100_000) + "=x",
      "--token ".repeat(12_000),
      "--" + "a".repeat(100_000) + "token ",
      'TOKEN="' + "a ".repeat(50_000),
      "API_KEY = ".repeat(10_000),
    ]
    const start = performance.now()
    for (const t of inputs) Redact.mask(t)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
