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
  // Pin the scheduler's user home explicitly. Some macOS runtimes do not derive os.homedir() from HOME.
  YUKIOSHI_TEST_HOME: home,
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
    env: { ...env, ...extra },
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

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    }
    if (process.platform === "darwin") {
      const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim()
      if (state.startsWith("Z")) return false
    }
    return true
  } catch {
    return false
  }
}

async function waitForCondition(check: () => boolean, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}

const toolResults = (body: Record<string, any> | undefined) =>
  ((body?.messages ?? []) as { role: string; content: unknown }[])
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))

await check("--version prints a version", async () => {
  const result = await yk(["--version"])
  expect(result.code === 0 && /\d+\.\d+\.\d+/.test(result.stdout), "no version", result)
})

await check("SIGKILL watchdog cleans a real binary child", async () => {
  const pidFile = path.join(root, "watchdog-child.pid")
  if (process.platform === "win32") {
    // Windows has no POSIX SIGKILL or process groups; prove the disabled fallback still spawns tools.
    const output = path.join(root, "watchdog-windows-spawn.txt")
    queue = [
      { tool: "bash", args: { command: `echo watchdog > ${JSON.stringify(output)}`, description: "spawn probe" } },
      { text: "done" },
    ]
    const result = await yk(["run", "--dangerously-skip-permissions", "run the spawn probe"])
    expect(result.code === 0 && fs.existsSync(output), "Windows child spawn fallback failed", result)
    return
  }

  const lspFile = path.join(project, "watchdog.repro")
  fs.writeFileSync(lspFile, "watchdog\n")
  globalConfig({
    lsp_tool: true,
    lsp: {
      watchdog: {
        command: ["/bin/sh", "-c", `printf '%s' "$$" > ${JSON.stringify(pidFile)}; sleep 60`],
        extensions: [".repro"],
      },
    },
  })
  queue = [
    {
      tool: "lsp",
      args: {
        operation: "documentSymbol",
        filePath: lspFile,
        line: 1,
        character: 1,
      },
    },
  ]
  const parent = Bun.spawn([bin!, "run", "--dangerously-skip-permissions", "run the watchdog child"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let childPid = 0
  try {
    await waitForCondition(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0,
      30_000,
      "real binary did not start the watchdog child",
    )
    childPid = Number(fs.readFileSync(pidFile, "utf8").trim())
    expect(Number.isInteger(childPid) && childPid > 0 && processAlive(childPid), `invalid child pid ${childPid}`)
    parent.kill("SIGKILL")
    await parent.exited
    await waitForCondition(() => !processAlive(childPid), 2_000, `child ${childPid} survived parent SIGKILL`)
  } finally {
    try { parent.kill("SIGKILL") } catch {}
    if (childPid > 0) try { process.kill(childPid, "SIGKILL") } catch {}
    globalConfig({})
  }
})

await check("SIGKILL watchdog cleans a bash tool child and its background job", async () => {
  if (process.platform === "win32") return
  const pidFile = path.join(root, "bash-watchdog.pids")
  queue = [
    {
      tool: "bash",
      args: { command: `echo $$ > ${JSON.stringify(pidFile)}; sleep 300 & echo $! >> ${JSON.stringify(pidFile)}; wait`, description: "orphan probe" },
    },
  ]
  const parent = Bun.spawn([bin!, "run", "--dangerously-skip-permissions", "run the orphan probe"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let pids: number[] = []
  const read = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").map(Number).filter((n) => n > 0) : [])
  try {
    await waitForCondition(() => read().length === 2, 30_000, "bash tool did not start its background job")
    pids = read()
    expect(pids.every(processAlive), `bash tool pids ${pids} are not alive`)
    parent.kill("SIGKILL")
    await parent.exited
    await waitForCondition(() => pids.every((pid) => !processAlive(pid)), 10_000, `bash tool pids ${pids} survived parent SIGKILL`)
  } finally {
    try { parent.kill("SIGKILL") } catch {}
    for (const pid of pids) try { process.kill(pid, "SIGKILL") } catch {}
  }
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

// ---- Helper: init a git repo in a directory ---------------------------------------------------------------

function initGit(dir: string) {
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  run("init", "-q")
  run("config", "user.email", "smoke@example.invalid")
  run("config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "base.txt"), "base")
  run("add", "base.txt")
  run("commit", "-qm", "initial")
  return run
}

// ---- Helper: await binary output line matching a pattern ---------------------------------------------------

async function waitForOutput(
  proc: ReturnType<typeof Bun.spawn>,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let seen = ""
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    seen += new TextDecoder().decode(value)
    const m = seen.match(pattern)
    if (m) return m[1] ?? m[0]
  }
  throw new Error(`Timed out waiting for ${pattern} in: ${seen.slice(-500)}`)
}

// ---- Worktrees ------------------------------------------------------------------------------------------

await check("worktree new/list/path/remove lifecycle", async () => {
  const wtProject = path.join(root, "wt-project")
  fs.mkdirSync(wtProject, { recursive: true })
  initGit(wtProject)

  const wtEnv = { ...env, HOME: home, USERPROFILE: home }

  const created = Bun.spawnSync([bin!, "worktree", "new", "smoke-wt"], {
    cwd: wtProject,
    env: wtEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const createdOut = created.stdout.toString() + created.stderr.toString()
  expect(created.exitCode === 0, `worktree new failed: ${createdOut}`)
  expect(
    createdOut.includes("smoke-wt") && createdOut.includes("yukioshi/smoke-wt"),
    `unexpected worktree new output: ${createdOut}`,
  )

  const listed = Bun.spawnSync([bin!, "worktree", "list"], {
    cwd: wtProject,
    env: wtEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listedOut = listed.stdout.toString() + listed.stderr.toString()
  expect(listed.exitCode === 0, `worktree list failed: ${listedOut}`)
  expect(listedOut.includes("smoke-wt"), `worktree list missing smoke-wt: ${listedOut}`)

  const located = Bun.spawnSync([bin!, "worktree", "path", "smoke-wt"], {
    cwd: wtProject,
    env: wtEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const wtDir = (located.stdout.toString() + located.stderr.toString()).trim()
  expect(located.exitCode === 0, `worktree path failed: ${wtDir}`)
  expect(fs.existsSync(path.join(wtDir, "base.txt")), `base.txt missing in worktree at ${wtDir}`)

  const removed = Bun.spawnSync([bin!, "worktree", "remove", "smoke-wt", "--yes"], {
    cwd: wtProject,
    env: wtEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const removedOut = removed.stdout.toString() + removed.stderr.toString()
  expect(removed.exitCode === 0, `worktree remove failed: ${removedOut}`)
  expect(!fs.existsSync(wtDir), `worktree dir still exists after remove: ${wtDir}`)
})

await check("run --worktree executes in the worktree checkout", async () => {
  // Needs a git project. Create one in the smoke's throwaway root.
  const wtProject = path.join(root, "wt-run-project")
  fs.mkdirSync(wtProject, { recursive: true })
  initGit(wtProject)

  const wtName = "smoke-run-wt"

  const created = Bun.spawnSync([bin!, "worktree", "new", wtName], {
    cwd: wtProject,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const createdOut = created.stdout.toString() + created.stderr.toString()
  expect(created.exitCode === 0, `worktree new failed: ${createdOut}`)

  try {
    const located = Bun.spawnSync([bin!, "worktree", "path", wtName], {
      cwd: wtProject,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const wtDir = (located.stdout.toString() + located.stderr.toString()).trim()
    const targetFile = path.join(wtDir, "wt-smoke-made.txt")
    const writeCmd = process.platform === "win32"
      ? `echo wt-content > "${targetFile.replace(/\\/g, "\\\\")}"`
      : `printf %s 'wt-content' > '${targetFile}'`
    queue = [{ tool: "bash", args: { command: writeCmd, description: "write in worktree" } }, { text: "done" }]

    const wtRunProc = Bun.spawn(
      [bin!, "run", "--worktree", wtName, "--dangerously-skip-permissions", "write a file in the worktree"],
      { cwd: wtProject, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [wtStdout, wtStderr] = await Promise.all([
      new Response(wtRunProc.stdout).text(),
      new Response(wtRunProc.stderr).text(),
    ])
    const wtCode = await wtRunProc.exited
    const runOut = wtStdout + wtStderr
    expect(wtCode === 0, `run --worktree failed: exit=${wtCode}\n${runOut.slice(-800)}`)
    // Main project dir must NOT have the file
    expect(!fs.existsSync(path.join(wtProject, "wt-smoke-made.txt")), "file leaked into main project dir")
    // Worktree dir must have the file
    expect(fs.existsSync(targetFile), `file not found in worktree at ${targetFile}`)
  } finally {
    Bun.spawnSync([bin!, "worktree", "remove", wtName, "--yes"], { cwd: wtProject, env, stdout: "pipe", stderr: "pipe" })
  }
})

// ---- Checkpoints ----------------------------------------------------------------------------------------

await check("checkpoints: enabled=true creates a checkpoint after a changed turn", async () => {
  const cpProject = path.join(root, "cp-project")
  fs.mkdirSync(cpProject, { recursive: true })
  const runGit = initGit(cpProject)
  const head = runGit("rev-parse", "HEAD")

  globalConfig({ checkpoints: { enabled: true } })

  const targetFile = path.join(cpProject, "base.txt")
  const writeCmd = process.platform === "win32"
    ? `echo checkpoint-value > "${targetFile.replace(/\\/g, "\\\\")}"`
    : `printf %s 'checkpoint-value' > '${targetFile}'`
  queue = [{ tool: "bash", args: { command: writeCmd, description: "write" } }, { text: "done" }]

  const cpRunProc = Bun.spawn(
    [bin!, "run", "--dangerously-skip-permissions", "--dir", cpProject, "write checkpoint-value to base"],
    { cwd: cpProject, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [cpStdout, cpStderr] = await Promise.all([
    new Response(cpRunProc.stdout).text(),
    new Response(cpRunProc.stderr).text(),
  ])
  const cpCode = await cpRunProc.exited
  const runOut = cpStdout + cpStderr
  globalConfig({})

  expect(cpCode === 0, `run failed (exit ${cpCode}): ${runOut.slice(-500)}`)

  // HEAD must not move
  const headAfter = runGit("rev-parse", "HEAD")
  expect(headAfter === head, `HEAD moved from ${head} to ${headAfter}`)

  // There should be at least one checkpoint ref
  const refs = runGit("for-each-ref", "--format=%(refname)", "refs/yukioshi/checkpoints")
  expect(refs.length > 0, "no checkpoint ref created under refs/yukioshi/checkpoints")
})

await check("checkpoint list/show work with the written checkpoint", async () => {
  // Uses the cp-project from the previous check.
  const cpProject = path.join(root, "cp-project")

  const listed = Bun.spawnSync([bin!, "checkpoint", "list"], {
    cwd: cpProject,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listedOut = listed.stdout.toString() + listed.stderr.toString()
  expect(listed.exitCode === 0, `checkpoint list failed (exit ${listed.exitCode}): ${listedOut}`)

  // Should have at least one checkpoint from the previous check
  const idMatch = listedOut.match(/^([0-9a-f]{12})\s/m)
  expect(!!idMatch, `no checkpoint ID in list output: ${listedOut}`)
  const cpId = idMatch![1]

  const shown = Bun.spawnSync([bin!, "checkpoint", "show", cpId], {
    cwd: cpProject,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const shownOut = shown.stdout.toString() + shown.stderr.toString()
  expect(shown.exitCode === 0, `checkpoint show failed (exit ${shown.exitCode}): ${shownOut.slice(0, 500)}`)
  expect(
    shownOut.includes("checkpoint-value") || shownOut.includes("base.txt"),
    `checkpoint show content unexpected: ${shownOut.slice(0, 500)}`,
  )
})

// ---- Schedule -------------------------------------------------------------------------------------------

await check("schedule add/list/run/remove (store + crontab on non-Windows, store-only on Windows)", async () => {
  const crontabFile = path.join(root, "smoke-crontab")
  const schedEnv = {
    ...env,
    ...(process.platform !== "win32" ? { YUKIOSHI_CRONTAB: crontabFile } : {}),
  }

  // Add a scheduled job
  const added = Bun.spawnSync(
    [bin!, "schedule", "add", "0 6 * * *", "smoke summary job", "--name", "smoke-sched", "--auto"],
    { cwd: project, env: schedEnv, stdout: "pipe", stderr: "pipe" },
  )
  const addedOut = added.stdout.toString() + added.stderr.toString()
  expect(added.exitCode === 0, `schedule add failed: ${addedOut}`)
  expect(addedOut.includes("smoke-sched"), `job name missing in add output: ${addedOut}`)
  const jobMatch = addedOut.match(/Added scheduled job ([0-9a-f]{8})/)
  expect(!!jobMatch, `no job ID in add output: ${addedOut}`)
  const jobId = jobMatch![1]

  // Crontab should contain the block on non-Windows
  if (process.platform !== "win32") {
    // macOS installs a LaunchAgent (crontab is only the fallback); Linux uses the crontab block.
    const plist = path.join(home, "Library", "LaunchAgents", `com.yukioshi.schedule.${jobId}.plist`)
    if (process.platform === "darwin" && fs.existsSync(plist)) {
      expect(fs.readFileSync(plist, "utf8").includes("schedule"), `LaunchAgent plist unexpected: ${plist}`)
    } else {
      const crontab = fs.readFileSync(crontabFile, "utf8")
      expect(
        crontab.includes("# BEGIN yukioshi schedule") && crontab.includes(`schedule run ${jobId}`),
        `crontab missing block: ${crontab.slice(0, 400)}`,
      )
    }
  }

  // List shows the job
  const listed = Bun.spawnSync([bin!, "schedule", "list"], {
    cwd: project,
    env: schedEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const listedOut = listed.stdout.toString() + listed.stderr.toString()
  expect(listed.exitCode === 0, `schedule list failed: ${listedOut}`)
  expect(listedOut.includes(jobId) && listedOut.includes("smoke-sched"), `job missing in list: ${listedOut}`)

  // Run the job immediately via the CLI (it launches an in-process run, so we must use async spawn
  // to keep the fake model server's event loop running while the job executes).
  queue = [{ text: "smoke-schedule-done" }]
  const ranProc = Bun.spawn([bin!, "schedule", "run", jobId], {
    cwd: project,
    env: schedEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [ranStdout, ranStderr] = await Promise.all([
    new Response(ranProc.stdout).text(),
    new Response(ranProc.stderr).text(),
  ])
  const ranCode = await ranProc.exited
  const ranOut = ranStdout + ranStderr
  expect(ranCode === 0, `schedule run failed (exit ${ranCode}): ${ranOut.slice(-600)}`)

  // Remove the job
  const removed = Bun.spawnSync([bin!, "schedule", "remove", jobId], {
    cwd: project,
    env: schedEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const removedOut = removed.stdout.toString() + removed.stderr.toString()
  expect(removed.exitCode === 0, `schedule remove failed: ${removedOut}`)
  expect(removedOut.includes(jobId), `job ID missing from remove output: ${removedOut}`)

  if (process.platform === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", `com.yukioshi.schedule.${jobId}.plist`)
    expect(!fs.existsSync(plist), `LaunchAgent plist not removed: ${plist}`)
  }
  // Crontab block cleaned up on non-Windows
  if (process.platform !== "win32" && fs.existsSync(crontabFile)) {
    const after = fs.readFileSync(crontabFile, "utf8")
    expect(!after.includes("# BEGIN yukioshi schedule"), `crontab block not removed: ${after.slice(0, 400)}`)
  }
})

// ---- Budget ---------------------------------------------------------------------------------------------

await check("budget.session stops the next request with exit code 6", async () => {
  globalConfig({ budget: { tokens: { session: 5 } } })

  // First turn: succeeds and uses tokens
  queue = [{ text: "first" }]
  const first = await yk(["run", "first turn"])
  expect(first.code === 0, `first run failed: ${first.stderr.slice(-400)}`)

  // Second turn continuing the session: budget is exceeded → exit code 6
  queue = [{ text: "second" }]
  const second = await yk(["run", "--continue", "second turn"])
  expect(second.code === 6, `expected exit 6 from budget, got ${second.code}\n${second.stderr.slice(-600)}`)
  expect(
    second.stderr.includes("budget") || second.stderr.includes("Budget") || second.stderr.includes("tokens"),
    `budget message missing: ${second.stderr.slice(-600)}`,
  )

  globalConfig({})
})

// ---- Redaction ------------------------------------------------------------------------------------------

await check("a fake secret in a tool result is masked before the model sees it", async () => {
  const secretFile = path.join(project, "smoke-secret.env")
  const fakeToken = "ghp_SmokeTestFakeToken123456789ABCDEF"
  fs.writeFileSync(secretFile, `GITHUB_TOKEN=${fakeToken}\n`)

  queue = [{ tool: "read", args: { filePath: secretFile } }, { text: "redacted" }]
  const result = await yk(["run", "--dangerously-skip-permissions", "read the secret file"])
  fs.unlinkSync(secretFile)

  expect(result.code === 0, `run failed: ${result.stderr.slice(-400)}`)

  // requests logged by the fake model must not contain the raw token
  const allBodies = JSON.stringify(requests)
  expect(!allBodies.includes(fakeToken), `raw token leaked into requests: ${allBodies.slice(0, 800)}`)
  expect(
    allBodies.includes("[REDACTED:github-token]") || allBodies.includes("REDACTED"),
    `redaction placeholder missing from requests: ${allBodies.slice(0, 800)}`,
  )
})

// ---- Goal -----------------------------------------------------------------------------------------------

await check("run --command goal exits 0 when the goal is reported done", async () => {
  // The goal checker looks for DONE: in the model reply.
  queue = [
    { text: "CONTINUE: still working on it" },
    { text: "DONE: the goal is complete" },
  ]
  const result = await yk(["run", "--command", "goal", "finish the task"])
  expect(result.code === 0, `goal run failed (exit ${result.code}): ${result.stderr.slice(-600)}`)
})

// ---- Memory ---------------------------------------------------------------------------------------------

await check("memory: save and recall a note across sessions", async () => {
  globalConfig({ memory: { enabled: true } })

  // First session: save a memory entry
  queue = [
    { tool: "memory_save", args: { action: "remember", key: "smoke-key", text: "always-use-bun" } },
    { text: "saved" },
  ]
  const saved = await yk(["run", "--dangerously-skip-permissions", "save project guidance"])
  expect(saved.code === 0, `memory save failed: ${saved.stderr.slice(-400)}`)

  // Second session: the saved note must appear in the system prompt sent to the model
  queue = [{ text: "recalled" }]
  const recalled = await yk(["run", "what do you remember?"])
  expect(recalled.code === 0, `memory recall run failed: ${recalled.stderr.slice(-400)}`)

  const allBodies = JSON.stringify(requests)
  expect(
    allBodies.includes("always-use-bun"),
    `saved memory note not present in subsequent requests: ${allBodies.slice(0, 800)}`,
  )

  globalConfig({})
})

// ---- Webhooks -------------------------------------------------------------------------------------------

await check("webhooks: turn.finished delivers a signed payload to a local HTTP server", async () => {
  const deliveries: { body: string; sig: string | null }[] = []
  const secret = "smoke-webhook-secret-value-xyz"

  const webhookServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      deliveries.push({
        body: await request.text(),
        sig: request.headers.get("X-YukiOshi-Signature"),
      })
      return new Response("ok")
    },
  })

  try {
    globalConfig({
      webhooks: [{ url: `http://127.0.0.1:${webhookServer.port}`, secret, events: ["turn.finished"] }],
    })

    queue = [{ text: "webhook-payload-smoke" }]
    const result = await yk(["run", "trigger webhook"])
    expect(result.code === 0, `run failed: ${result.stderr.slice(-400)}`)

    // Wait up to 5 s for the delivery
    const deadline = Date.now() + 5_000
    while (deliveries.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(deliveries.length === 1, `expected 1 webhook delivery, got ${deliveries.length}`)

    const payload = JSON.parse(deliveries[0]!.body) as Record<string, unknown>
    expect(payload.event === "turn.finished", `unexpected event type: ${payload.event}`)
    expect(typeof payload.time === "string", `time field missing: ${JSON.stringify(payload)}`)
    const sess = payload.session as Record<string, unknown> | undefined
    expect(sess !== undefined && typeof (sess.id ?? sess) === "string", `session field missing or wrong type: ${JSON.stringify(payload)}`)

    // Verify HMAC signature
    const hmac = (await import("node:crypto")).createHmac("sha256", secret)
      .update(deliveries[0]!.body)
      .digest("hex")
    expect(
      deliveries[0]!.sig === `sha256=${hmac}`,
      `HMAC mismatch: got ${deliveries[0]!.sig}, want sha256=${hmac}`,
    )
  } finally {
    globalConfig({})
    webhookServer.stop(true)
  }
})

server.stop(true)
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed on ${process.platform}-${process.arch}`)
process.exit(failed.length ? 1 : 0)
