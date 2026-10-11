// Shared helpers for the security regression suite (test/e2e/security/*).
// Every scenario drives the real CLI as a child process against a fake model server and asserts on
// what the fake server received and on the files the process left behind.
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { config, runtimeEnv } from "../helpers"

export const FAKE = {
  aws: "AKIAIOSFODNN7EXAMPLE",
  github: "ghp_FakeSecurityRegression1234567890abcd",
  openai: "sk-FakeSecurityRegressionKey0123456789abcdefgh",
  privateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIFakeSecurityRegressionKeyBodyLine1\nFakeSecurityRegressionKeyBodyLine2\n-----END RSA PRIVATE KEY-----",
  postgres: "postgres://dbuser:FakeDbPassw0rdSecReg@db.internal.example/app",
}
// The substrings that must never appear anywhere they should be masked.
export const FAKE_NEEDLES = [
  FAKE.aws,
  FAKE.github,
  FAKE.openai,
  "MIIFakeSecurityRegressionKeyBodyLine1",
  "FakeDbPassw0rdSecReg",
]

export function leaked(text: string) {
  return FAKE_NEEDLES.filter((needle) => text.includes(needle))
}

// A git project below `home` (HOME is `home`, so `~/...` is outside the project).
export function makeProject(home: string, name = "proj") {
  const dir = path.join(home, name)
  fs.mkdirSync(dir, { recursive: true })
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
  return dir
}

export function projectEnv(home: string, llmUrl: string, extra: Record<string, unknown> = {}) {
  return {
    ...runtimeEnv(home),
    YUKIOSHI_DISABLE_PROJECT_CONFIG: "",
    YUKIOSHI_CONFIG_CONTENT: config(llmUrl, extra),
  }
}

export function plainEnv(home: string, llmUrl: string, extra: Record<string, unknown> = {}) {
  return { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llmUrl, extra) }
}

// A local HTTP server that records every request: the "attacker".
export function attacker(handler?: (request: Request, body: string) => Response | Promise<Response>) {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.text().catch(() => "")
      seen.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      })
      return handler ? handler(request, body) : new Response("attacker", { status: 200 })
    },
  })
  return { server, seen, url: server.url.toString().replace(/\/$/, "") }
}

export const stopOnExit = (server: { stop: (force?: boolean) => void }) =>
  Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

export const exists = (...parts: string[]) => fs.existsSync(path.join(...parts))

export function walk(dir: string, out: string[] = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export function readAll(files: string[]) {
  return files
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8")
      } catch {
        return ""
      }
    })
    .join("\n")
}

// Everything the CLI wrote below the isolated config/data/state/cache dirs and the home dir.
export function everythingWritten(home: string) {
  const roots = [home, `${home}-config`, `${home}-data`, `${home}-state`, `${home}-cache`]
  return readAll(roots.flatMap((root) => walk(root)).filter((file) => !file.includes(`${path.sep}.git${path.sep}`)))
}

// The user's own (global) config file. Written synchronously, unlike helpers.globalConfig.
export function userConfig(home: string, value: Record<string, unknown>) {
  const dir = `${home}-config/yukioshi`
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "yukioshi.json")
  const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {}
  fs.writeFileSync(file, JSON.stringify({ ...current, ...value }))
}

// Fails with the surrounding text of each leaked key, so a CI failure shows where it leaked.
export function expectClean(label: string, text: string) {
  const found = FAKE_NEEDLES.filter((needle) => text.includes(needle)).map((needle) => {
    const at = text.indexOf(needle)
    return `${needle.slice(0, 14)}... in: ${JSON.stringify(text.slice(Math.max(0, at - 120), at + 60))}`
  })
  if (found.length > 0) throw new Error(`${label} leaked credentials:\n${found.join("\n")}`)
}
