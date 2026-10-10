import { describe, expect, test } from "bun:test"
import { sanitizeDelegateEnv } from "../../src/delegate/client"

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

describe("delegate child process environment", () => {
  test("drops variables whose value is a credential, whatever the name", () => {
    const env = sanitizeDelegateEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      MY_PAT: github,
      SOMETHING: openai,
      MONGODB_URI: "mongodb://user:pw123456@db.example.com/app",
      REDIS_URL: "redis://:pw123456@cache.example.com",
    })
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me" })
    expect(JSON.stringify(env)).not.toContain(github)
    expect(JSON.stringify(env)).not.toContain(openai)
  })

  test("still drops the named credentials", () => {
    const env = sanitizeDelegateEnv({
      GITHUB_TOKEN: "x",
      ANTHROPIC_API_KEY: "y",
      AWS_SECRET_ACCESS_KEY: "z",
      EDITOR: "vi",
    })
    expect(env).toEqual({ EDITOR: "vi" })
  })
})
