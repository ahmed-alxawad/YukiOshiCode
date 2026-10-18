#!/usr/bin/env bun

// Small, repeatable CLI benchmark. It deliberately uses a local instant model
// so the measurements describe CLI work, not network or model latency.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Samples = {
  readonly version: number[]
  readonly help: number[]
  readonly firstRequest: number[]
  readonly turn: number[]
}

export type Summary = {
  readonly median: number
  readonly p90: number
  readonly min: number
  readonly max: number
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new Error("cannot summarize an empty sample")
  const sorted = values.toSorted((a, b) => a - b)
  const rank = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
  return { median: rank(0.5), p90: rank(0.9), min: sorted[0]!, max: sorted.at(-1)! }
}

export function parseArgs(args: readonly string[]) {
  let runs = 10
  let binary: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--runs" || arg === "-n") {
      runs = Number(args[++index])
      if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer")
      continue
    }
    if (arg === "--binary") {
      binary = args[++index]
      if (!binary) throw new Error("--binary requires a path")
      continue
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run script/bench.ts [--runs N] [--binary PATH]")
      process.exit(0)
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { runs, binary }
}

export function formatMetric(name: string, values: readonly number[]) {
  const summary = summarize(values)
  return `${name.padEnd(25)} median=${summary.median.toFixed(1)}ms p90=${summary.p90.toFixed(1)}ms min=${summary.min.toFixed(1)}ms max=${summary.max.toFixed(1)}ms`
}

export const disclaimer =
  "Diagnostics only: no comparison with other tools is claimed, and no AI speed claims are made."

function sse(text: string) {
  const chunk = {
    id: "bench",
    object: "chat.completion.chunk",
    created: 0,
    model: "instant",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  }
  const done = {
    id: "bench",
    object: "chat.completion.chunk",
    created: 0,
    model: "instant",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}

type FakeModel = { readonly url: string; readonly requests: number; stop(): Promise<void> }

function fakeModel(onRequest: (request: Request) => void): FakeModel {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests++
      onRequest(request)
      await request.json().catch(() => undefined)
      return new Response(sse("bench-ok"), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    get requests() {
      return requests
    },
    url: `${server.url}v1`,
    stop: async () => {
      await server.stop(true)
    },
  }
}

type Result = { readonly code: number; readonly stdout: string; readonly stderr: string }

async function invoke(command: string[], env: Record<string, string>, cwd: string): Promise<Result> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 60_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  clearTimeout(timeout)
  if (code !== 0) throw new Error(`command failed (${code}): ${stderr || stdout}`)
  return { code, stdout, stderr }
}

async function main() {
  const { runs, binary } = parseArgs(process.argv.slice(2))
  const packageRoot = path.resolve(import.meta.dir, "..")
  const command = binary ? [path.resolve(binary)] : [process.execPath, path.join(packageRoot, "src/index.ts")]
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yk-bench-")))
  const project = path.join(root, "project")
  const home = path.join(root, "home")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  let firstRequestResolve: (() => void) | undefined
  let firstRequest = Promise.resolve()
  const model = fakeModel(() => firstRequestResolve?.())
  const env = {
    HOME: home,
    USERPROFILE: home,
    PWD: project,
    YUKIOSHI_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    YUKIOSHI_CONFIG_CONTENT: JSON.stringify({
      model: "fake/instant",
      small_model: "fake/instant",
      permission: { "*": "allow", external_directory: "allow" },
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          api: model.url,
          options: { apiKey: "bench" },
          models: { instant: { name: "Instant", limit: { context: 200_000, output: 1_000 } } },
        },
      },
    }),
    YUKIOSHI_DISABLE_AUTOUPDATE: "1",
    YUKIOSHI_DISABLE_MODELS_FETCH: "1",
    YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
    YUKIOSHI_PURE: "1",
  }
  const samples: Samples = { version: [], help: [], firstRequest: [], turn: [] }

  try {
    for (let index = 0; index < runs; index++) {
      let start = performance.now()
      await invoke([...command, "--version"], env, project)
      samples.version.push(performance.now() - start)

      start = performance.now()
      await invoke([...command, "run", "--help"], env, project)
      samples.help.push(performance.now() - start)

      firstRequest = new Promise<void>((resolve) => {
        firstRequestResolve = resolve
      })
      start = performance.now()
      const turn = invoke([...command, "run", "benchmark turn"], env, project)
      await firstRequest
      samples.firstRequest.push(performance.now() - start)
      await turn
      samples.turn.push(performance.now() - start)
      firstRequestResolve = undefined
    }
  } finally {
    await model.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log("YukiOshi Code CLI benchmark (local fake instant model)")
  console.log("Platforms: Linux/macOS/Windows; this run: " + process.platform)
  console.log(disclaimer)
  console.log(`Samples: ${runs}`)
  console.log(formatMetric("--version", samples.version))
  console.log(formatMetric("run --help", samples.help))
  console.log(formatMetric("start-to-first-request", samples.firstRequest))
  console.log(formatMetric("total scripted turn", samples.turn))
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
