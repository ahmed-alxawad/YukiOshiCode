import { describe, expect, test } from "bun:test"
import { Redact } from "@yukioshi/core/redact"

// Formats that reached the model, hooks and webhooks unmasked (nightmare review, 2026-10-21).
const secrets: Array<[string, string]> = [
  ['{"password": "hunter2hunter2"}', "hunter2hunter2"],
  ['{"api_key":"abcd1234efgh5678"}', "abcd1234efgh5678"],
  ['"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
  ['"SessionToken": "IQoJb3JpZ2luX2VjEXAMPLETOKENVALUE"', "IQoJb3JpZ2luX2VjEXAMPLETOKENVALUE"],
  ["X-Api-Key: 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"],
  ["Authorization: Basic YWRtaW46c2VjcmV0cGFzcw==", "YWRtaW46c2VjcmV0cGFzcw=="],
  ["authorization: token 0123456789abcdef0123", "0123456789abcdef0123"],
  ["curl -u admin:S3cretPass https://example.com", "S3cretPass"],
  ["mysql -h db -u root -pS3cretPass mydb", "S3cretPass"],
  ["sshpass -p S3cretPass ssh host", "S3cretPass"],
  ["docker login -u me -p S3cretPass registry.example", "S3cretPass"],
  ["glpat-AbCdEfGhIjKlMnOpQrSt", "glpat-AbCdEfGhIjKlMnOpQrSt"],
  ["hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
  ["npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
  ["SG.AbCdEfGhIjKlMnOpQr.StUvWxYz0123456789ab", "SG.AbCdEfGhIjKlMnOpQr.StUvWxYz0123456789ab"],
  ["DefaultEndpointsProtocol=https;AccountName=x;AccountKey=AbCdEfGhIjKlMnOpQrStUvWx==;", "AbCdEfGhIjKlMnOpQrStUvWx=="],
  ["DB_PASS=S3cretPass", "S3cretPass"],
  ["MYSQL_PWD=S3cretPass", "S3cretPass"],
  ["PRIVATE_KEY=0xabcdef0123456789", "0xabcdef0123456789"],
  ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----", "lQOYBF"],
]

const harmless = [
  "author: Jane Doe",
  '{"author": "Jane Doe", "passengers": 4}',
  "git commit -m 'update password docs'",
  "ls -la /usr/bin",
  "npm install --save-dev typescript",
  "grep -p pattern file.txt",
]

describe("redaction of common secret formats", () => {
  test.each(secrets)("masks %s", (text, secret) => {
    const masked = Redact.mask(text)
    expect(masked).not.toContain(secret)
    expect(masked).toContain("[REDACTED:")
  })

  test.each(harmless)("leaves %s alone", (text) => {
    expect(Redact.mask(text)).toBe(text)
  })

  test("maskDeep masks values under secret keys whatever their shape", () => {
    const out = Redact.maskDeep({ tool_input: { password: "hunter2", SecretAccessKey: "abcd", author: "Jane", note: "ok" } })
    expect(out.tool_input.password).toBe("[REDACTED:password]")
    expect(out.tool_input.SecretAccessKey).toBe("[REDACTED:secret]")
    expect(out.tool_input.author).toBe("Jane")
    expect(out.tool_input.note).toBe("ok")
  })

  test("maskDeep respects the allow list and redaction being off", () => {
    expect(Redact.maskDeep({ password: "hunter2" }, { allow: ["hunter2"] }).password).toBe("hunter2")
    expect(Redact.maskDeep({ password: "hunter2" }, { enabled: false }).password).toBe("hunter2")
  })
})
