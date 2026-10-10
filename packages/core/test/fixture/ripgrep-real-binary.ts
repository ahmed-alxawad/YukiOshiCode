// Runs the real Ripgrep + RipgrepBinary services with a stubbed network and no `rg` on PATH.
// Executed in a subprocess by ripgrep-missing-binary.test.ts so XDG/PATH are controlled before Global loads.
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Cause } from "effect"
import { LayerNode } from "../../src/effect/layer-node"
import { Ripgrep } from "../../src/ripgrep"

const scenario = process.argv[2] ?? "reject"
const originalFetch = globalThis.fetch
const requested: string[] = []

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input)
  requested.push(url)
  if (scenario === "reject") throw new TypeError("network unreachable")
  if (scenario === "http500") return new Response("boom", { status: 500 })
  if (scenario === "badhash") return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
  if (scenario === "empty") return new Response(new Uint8Array(), { status: 200 })
  if (scenario === "evil-redirect")
    return new Response(null, { status: 302, headers: { location: "https://evil.example.com/rg.tar.gz" } })
  if (scenario === "http-redirect")
    return new Response(null, { status: 302, headers: { location: "http://github.com/rg.tar.gz" } })
  if (scenario === "signal-check") {
    if (!init?.signal) throw new Error("download fetch has no abort signal")
    throw new TypeError("offline")
  }
  if (scenario === "hang")
    return new Promise((_, reject) => {
      const signal = init?.signal ?? undefined
      signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  return originalFetch(input)
}) as typeof fetch

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-real-"))
await fs.writeFile(path.join(dir, "a.txt"), "hello needle\n")
await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n")
await fs.writeFile(path.join(dir, "ignored.txt"), "needle ignored\n")

const layer = LayerNode.compile(Ripgrep.node)
const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    return yield* (yield* Ripgrep.Service).grep({ cwd: dir, pattern: "needle", limit: 10 })
  }).pipe(Effect.provide(layer)),
)
await fs.rm(dir, { recursive: true, force: true })
console.log(
  "RESULT " +
    JSON.stringify({
      ok: Exit.isSuccess(exit),
      paths: Exit.isSuccess(exit) ? exit.value.map((m) => m.entry.path) : [],
      error: Exit.isFailure(exit) ? Cause.pretty(exit.cause).slice(0, 300) : undefined,
      requested,
    }),
)
process.exit(0)
