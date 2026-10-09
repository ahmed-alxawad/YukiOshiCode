import { describe, expect, test } from "bun:test"
import { Redact } from "../src/redact"

describe("redact URL credentials", () => {
  test("masks only the password of a database URL", () => {
    expect(Redact.mask("postgres://admin:s3cretPw@db.internal:5432/app")).toBe(
      "postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app",
    )
  })

  test("masks https tokens, empty usernames and passwords containing @", () => {
    expect(Redact.mask("git clone https://user:ghx9a8b7c@github.com/o/r.git")).toBe(
      "git clone https://user:[REDACTED:url-credentials]@github.com/o/r.git",
    )
    expect(Redact.mask("redis://:hunter2@cache:6379")).toBe("redis://:[REDACTED:url-credentials]@cache:6379")
    expect(Redact.mask("mysql://u:p@ss@host/db")).toBe("mysql://u:[REDACTED:url-credentials]@host/db")
  })

  test("records the real password in the report and is idempotent", () => {
    const r = Redact.maskWithReport("amqp://bob:pw123@mq")
    expect(r.matches).toEqual([{ kind: "url-credentials", value: "pw123", placeholder: "[REDACTED:url-credentials]" }])
    expect(Redact.mask(r.text)).toBe(r.text)
  })

  test("leaves URLs without credentials alone", () => {
    for (const t of [
      "https://example.com/path?x=1",
      "http://localhost:3000/api",
      "http://host:8080/a@b",
      "ssh://git@github.com/org/repo.git",
      "see https://a.com:443 and mail me@x.com",
      "https://user@host/path",
      "postgres://user:${DB_PASSWORD}@host/db",
    ]) {
      expect(Redact.mask(t)).toBe(t)
    }
  })

  test("is linear on hostile input", () => {
    const inputs = [
      "a://" + "b".repeat(100_000),
      "a://a:".repeat(20_000),
      "http://" + "u".repeat(100_000) + ":p@h",
      "http://u:" + "p".repeat(100_000),
      "http://u:" + "@".repeat(100_000),
      "x".repeat(100_000) + "://",
    ]
    const start = performance.now()
    for (const t of inputs) Redact.mask(t)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
