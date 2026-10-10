#!/usr/bin/env bun
// Smoke tests for a built `yukioshi` binary: `bun script/smoke.ts <path-to-yukioshi>`.
//
// Runs the binary the way users will, on Linux, macOS, and Windows, against a small fake OpenAI-compatible
// model served from this process, in a throwaway environment (its own XDG folders and HOME). Uses only Bun's
// built-ins, so it needs no `bun install`. Prints one line per check and exits non-zero if any fails.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let bin = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!bin || !fs.existsSync(bin)) {
  if (bin && process.platform === "win32" && fs.existsSync(bin + ".exe")) {
    bin = bin + ".exe"
  } else {
    const ext = process.platform === "win32" ? ".exe" : ""
    const platform = process.platform === "win32" ? "windows" : process.platform
    const defaultBin = path.resolve(`packages/opencode/dist/yukioshi-${platform}-${process.arch}/bin/yukioshi${ext}`)
    if (fs.existsSync(defaultBin)) {
      bin = defaultBin
    } else {
      console.error("usage: bun script/smoke.ts <path-to-yukioshi>")
      process.exit(2)
    }
  }
}

// ---- Fake model -------------------------------------------------------------------------------------------

type Reply = { text: string } | { tool: string; args: Record<string, unknown> }
let queue: Reply[] = []
let requests: Record<string, any>[] = []

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  const body: Record<string, unknown> = {
    id: "smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: "test",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (finish) body.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  return `data: ${JSON.stringify(body)}\n\n`
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json().catch(() => ({}))) as Record<string, any>
    requests.push(body)
    const reply = queue.shift() ?? { text: "ok" }
    const parts =
      "tool" in reply
        ? [
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: reply.text }), chunk({}, "stop")]
    return new Response(parts.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})

// ---- Throwaway environment --------------------------------------------------------------------------------

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yk-smoke-")))
const home = path.join(root, "home")
const project = path.join(root, "project")
for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true })
const xdg = {
  config: path.join(root, "config"),
  data: path.join(root, "data"),
  state: path.join(root, "state"),
  cache: path.join(root, "cache"),
}
const provider = {
  model: "fake/test",
  small_model: "fake/test",
  permission: { "*": "allow", external_directory: "allow" },
  provider: {
    fake: {
      npm: "@ai-sdk/openai-compatible",
      api: `http://127.0.0.1:${server.port}/v1`,
      options: { apiKey: "smoke" },
      models: { test: { name: "Test", tool_call: true, limit: { context: 200_000, output: 8_000 } } },
    },
  },
}
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg.config,
  XDG_DATA_HOME: xdg.data,
  XDG_STATE_HOME: xdg.state,
  XDG_CACHE_HOME: xdg.cache,
  YUKIOSHI_CONFIG_CONTENT: JSON.stringify(provider),
  YUKIOSHI_DISABLE_AUTOUPDATE: "1",
  YUKIOSHI_DISABLE_MODELS_FETCH: "1",
}

function globalConfig(value: Record<string, unknown>) {
  fs.mkdirSync(path.join(xdg.config, "yukioshi"), { recursive: true })
  fs.writeFileSync(path.join(xdg.config, "yukioshi", "yukioshi.json"), JSON.stringify(value))
}

type Result = { code: number; stdout: string; stderr: string }

async function yk(args: string[], extra: Record<string, string> = {}): Promise<Result> {
  const proc = Bun.spawn([bin!, ...args], {
    cwd: project,
    // Bun.spawn leaves PWD at the parent's value; a shell would have set it to the project.
    env: { ...env, PWD: project, ...extra },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 180_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout, stderr }
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

// ---- Checks -----------------------------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail?: string }[] = []

async function check(name: string, run: () => Promise<void>) {
  queue = []
  requests = []
  try {
    await run()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail })
    console.log(`FAIL  ${name}\n      ${detail.split("\n").join("\n      ")}`)
  }
}

function expect(condition: unknown, message: string, result?: Result) {
  if (condition) return
  const tail = result ? `\nexit ${result.code}\nstdout: ${result.stdout.slice(-1500)}\nstderr: ${result.stderr.slice(-1500)}` : ""
  throw new Error(message + tail)
}

const toolResults = (body: Record<string, any> | undefined) =>
  ((body?.messages ?? []) as { role: string; content: unknown }[])
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))

await check("--version prints a version", async () => {
  const result = await yk(["--version"])
  expect(result.code === 0 && /\d+\.\d+\.\d+/.test(result.stdout), "no version", result)
})

await check("run prints the model's answer", async () => {
  queue = [{ text: "SMOKE-ANSWER" }]
  const result = await yk(["run", "say something"])
  expect(result.code === 0 && result.stdout.includes("SMOKE-ANSWER"), "answer missing", result)
})

await check("a read tool call reaches the model with the file's text", async () => {
  const file = path.join(project, "notes.txt")
  fs.writeFileSync(file, "SMOKE-NOTES\n")
  queue = [{ tool: "read", args: { filePath: file } }, { text: "read it" }]
  const result = await yk(["run", "read the notes"])
  expect(result.code === 0, "run failed", result)
  expect(toolResults(requests.at(-1)).some((text) => text.includes("SMOKE-NOTES")), "tool result missing", result)
})

await check("--output-schema prints only the JSON answer", async () => {
  queue = [{ tool: "StructuredOutput", args: { answer: "42" } }]
  const schema = JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] })
  const result = await yk(["run", "--output-schema", schema, "answer"])
  expect(result.code === 0 && result.stdout.trim() === '{"answer":"42"}', "unexpected stdout", result)
})

await check("--max-turns stops with exit code 5", async () => {
  const file = path.join(project, "notes.txt")
  queue = [{ tool: "read", args: { filePath: file } }, { tool: "read", args: { filePath: file } }, { text: "done" }]
  const result = await yk(["run", "--max-turns", "1", "read twice"])
  expect(result.code === 5, "expected exit code 5", result)
})

await check("--format json ends with a result event", async () => {
  queue = [{ text: "json answer" }]
  const result = await yk(["run", "--format", "json", "answer in json"])
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "{}"
  const last = JSON.parse(lastLine)
  expect(result.code === 0 && last.type === "result" && last.exit_code === 0, "no result event", result)
})

await check("--mode plan refuses a file write", async () => {
  const file = path.join(project, "plan-write.txt")
  queue = [{ tool: "write", args: { filePath: file, content: "x" } }, { text: "done" }]
  const result = await yk(["run", "--mode", "plan", "write a file"])
  expect(!fs.existsSync(file), "the file was written", result)
})

await check("the audit log records tool calls", async () => {
  globalConfig({ audit: { enabled: true } })
  const file = path.join(project, "notes.txt")
  queue = [{ tool: "read", args: { filePath: file } }, { text: "done" }]
  const result = await yk(["run", "read for the audit"])
  globalConfig({})
  const dir = path.join(xdg.state, "yukioshi", "audit")
  const lines = fs.existsSync(dir)
    ? fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/).filter(Boolean))
    : []
  expect(lines.some((line) => JSON.parse(line).event === "tool"), "no audit entry", result)
})

await check("import reads a Claude Code transcript", async () => {
  const file = path.join(root, "transcript.jsonl")
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "user", cwd: project, message: { role: "user", content: "fix the bug" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fixed it" }] } }),
    ].join("\n"),
  )
  const result = await yk(["import", file])
  expect(result.code === 0 && result.stdout.includes("Imported 2 messages from Claude Code"), "import failed", result)
})

await check("skill add installs a skill from a git repository", async () => {
  const source = path.join(root, "skill-source")
  fs.mkdirSync(path.join(source, "smoke-skill"), { recursive: true })
  fs.writeFileSync(
    path.join(source, "smoke-skill", "SKILL.md"),
    "---\nname: smoke-skill\ndescription: A skill for the smoke test\n---\n\nSay hello.\n",
  )
  git(source, "init", "-q")
  git(source, "-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke", "add", ".")
  git(source, "-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke", "commit", "-qm", "skill")
  const bare = path.join(root, "skill-bare.git")
  git(root, "clone", "--bare", "-q", source, bare)
  const added = await yk(["skill", "add", bare, "--name", "smoke-skills"])
  expect(added.code === 0, "skill add failed", added)
  const listed = await yk(["skill", "list"])
  const listedOutput = listed.stdout + listed.stderr
  expect(listedOutput.includes("smoke-skill"), "skill not listed", listed)
})

await check("serve accepts a trigger with the right token only", async () => {
  const token = "smoke-trigger-token-0123456789abcdef"
  globalConfig({ triggers: { enabled: true, token_env: "YUKIOSHI_SMOKE_TOKEN", directories: [project], mode: "review" } })
  const proc = Bun.spawn([bin!, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: project,
    env: { ...env, YUKIOSHI_SMOKE_TOKEN: token },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const reader = proc.stdout.getReader()
    let seen = ""
    const deadline = Date.now() + 60_000
    let url: string | undefined
    while (!url && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      seen += new TextDecoder().decode(value)
      url = seen.match(/listening on (http:\/\/[^\s]+)/)?.[1]
    }
    expect(url, `serve did not start: ${seen}`)
    const send = (auth: string) =>
      fetch(`${url}/trigger`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "say hello", directory: project }),
      })
    const wrong = await send("not-the-token-not-the-token-not-the-token")
    expect(wrong.status === 401, `wrong token gave ${wrong.status}`)
    queue = [{ text: "hello from the trigger" }]
    const right = await send(token)
    expect(right.status === 202, `right token gave ${right.status}: ${await right.text()}`)
  } finally {
    proc.kill()
    await proc.exited
    globalConfig({})
  }
})

server.stop(true)
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed on ${process.platform}-${process.arch}`)
process.exit(failed.length ? 1 : 0)
