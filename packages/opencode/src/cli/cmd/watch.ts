import type { Argv } from "yargs"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { watch as fsWatch } from "fs"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProjectTrust } from "@/project/trust"
import {
  batchIgnoreCheck,
  fatalWatcherStop,
  findTriggers,
  gitIgnored,
  markTaskFailed,
  promptFor,
  queueTriggers,
  removeMarker,
  stopRun,
  triggerKey,
  watchRootLostMessage,
  watchScanErrorMessage,
  watchStopMessage,
  WATCH_MAX_ATTEMPTS,
  type TaskLog,
  type Trigger,
} from "../../watch"

const MAX_BYTES = 1024 * 1024
const SKIP = new Set([".git", "node_modules"])

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const out = await new Response(proc.stdout).text()
  return { code: await proc.exited, out }
}

/** How this same program starts: `bun src/index.ts` from a checkout, the binary itself otherwise. */
function selfCommand() {
  const exe = path.basename(process.execPath).toLowerCase()
  return /^(bun|node)(\.exe)?$/.test(exe) ? [process.execPath, process.argv[1]] : [process.execPath]
}

export const WatchCommand = effectCmd({
  command: "watch [dir]",
  describe: "watch files for comments ending in AI! (do it) or AI? (answer it) and run the agent on them",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("dir", { type: "string", describe: "folder inside the repository to watch (defaults to the current directory)" })
      .option("mode", {
        type: "string",
        choices: ["review", "plan", "auto"] as const,
        default: "review",
        describe: "permission mode for the runs (auto-all is refused)",
      })
      .option("model", { alias: "m", type: "string", describe: "model to use in the format of provider/model" })
      .option("dry-run", { type: "boolean", default: false, describe: "print what would run and run nothing" })
      .option("once", { type: "boolean", default: false, describe: "exit after the first trigger has been handled" })
      .example("$0 watch", "start watching the current repository")
      .example("$0 watch src --mode plan", "watch src and only plan"),
  handler: Effect.fn("Cli.watch")(function* (args: {
    dir?: string
    mode: string
    model?: string
    "dry-run": boolean
    once: boolean
  }) {
    if (!["review", "plan", "auto"].includes(args.mode))
      return yield* fail(`Mode ${args.mode} is not allowed for watch. Use review, plan or auto.`)
    const dir = yield* Effect.promise(() => fs.realpath(path.resolve(args.dir ?? process.cwd())).catch(() => undefined))
    if (!dir) return yield* fail(`Folder not found: ${args.dir}`)
    const top = yield* Effect.promise(() => git(dir, ["rev-parse", "--show-toplevel"]).catch(() => ({ code: 1, out: "" })))
    if (top.code !== 0) return yield* fail("This folder is not a git repository. cd into your project and try again.")
    const root = yield* Effect.promise(() => fs.realpath(top.out.trim()))
    if (!(yield* Effect.promise(() => ProjectTrust.isTrusted(root))))
      return yield* fail(`${root} is not trusted. Run \`yukioshi trust ${root}\` first, then start watch again.`)

    yield* Effect.promise(() => watchLoop({ ...args, dryRun: args["dry-run"], root, dir }))
  }),
})

type Options = { root: string; dir: string; mode: string; model?: string; dryRun: boolean; once: boolean }

/** What happened to the marker during a run: removed (task may run again), kept (never re-run), or failed (retry with backoff). */
type Outcome = "removed" | "kept" | "failed"

async function watchLoop(opts: Options) {
  const { root } = opts
  const queue: { file: string; trigger: Trigger }[] = []
  const seen: TaskLog = new Map()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let running = false
  let stopping = false
  let current: ReturnType<typeof Bun.spawn> | undefined
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))

  /** Ends the loop after a fatal watcher condition (vanished root, fs.watch error) with a non-zero exit. */
  const stopLoudly = (message: string) => {
    if (stopping) return
    stopping = true
    fatalWatcherStop(message, UI.println, finish)
  }

  const inside = (file: string) => file === root || file.startsWith(root + path.sep)

  const gitIgnores = batchIgnoreCheck((rels) => gitIgnored(root, rels))

  async function ignored(rel: string) {
    if (rel.split(path.sep).some((part) => SKIP.has(part))) return true
    return gitIgnores(rel)
  }

  async function scan(rel: string) {
    const abs = path.join(root, rel)
    const real = await fs.realpath(abs).catch(() => undefined)
    if (!real || !inside(real)) return
    const stat = await fs.stat(real).catch(() => undefined)
    if (!stat?.isFile() || stat.size > MAX_BYTES) return
    if (await ignored(rel)) return
    const content = await fs.readFile(real, "utf8").catch(() => undefined)
    if (content === undefined || content.includes("\0")) return
    queue.push(...queueTriggers(seen, rel, findTriggers(content, rel), Date.now()).map((trigger) => ({ file: rel, trigger })))
    void next()
  }

  async function next() {
    if (running) return
    const item = queue.shift()
    if (!item) return
    running = true
    const key = triggerKey(item.file, item.trigger)
    let outcome: Outcome = "failed"
    try {
      outcome = await handle(item.file, item.trigger)
    } catch (error) {
      UI.println(`watch: ${item.file}:${item.trigger.line} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (outcome === "removed") seen.delete(key)
    else if (outcome === "failed" && markTaskFailed(seen, key, Date.now()))
      UI.println(`watch: giving up on ${item.file}:${item.trigger.text} after ${WATCH_MAX_ATTEMPTS} attempts`)
    running = false
    if (opts.once) return finish()
    void next()
  }

  async function handle(file: string, trigger: Trigger): Promise<Outcome> {
    UI.println(`${opts.dryRun ? "would run" : "running"} ${trigger.kind === "ask" ? "AI?" : "AI!"} ${file}:${trigger.line}: ${trigger.text}`)
    if (opts.dryRun) return "kept"
    const cmd = [
      ...selfCommand(),
      "run",
      "--mode",
      opts.mode,
      ...(opts.model ? ["--model", opts.model] : []),
      promptFor(file, trigger),
    ]
    const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "inherit", stdin: "ignore" })
    current = proc
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    current = undefined
    if (stopping) return "kept"
    if (code !== 0) {
      UI.println(`watch: run exited with code ${code}; marker left in place`)
      return "failed"
    }
    const abs = path.join(root, file)
    const real = await fs.realpath(abs).catch(() => undefined)
    if (!real || !inside(real)) return "kept"
    const content = await fs.readFile(real, "utf8")
    const answer = trigger.kind === "ask" ? out.trim() : undefined
    const updated = removeMarker(content, trigger, answer)
    if (updated === undefined) {
      UI.println(`watch: ${file}:${trigger.line} changed during the run; marker left in place`)
      return "kept"
    }
    await fs.writeFile(real, updated)
    return "removed"
  }

  const watcher = fsWatch(opts.dir, { recursive: true }, (_event, name) => {
    if (!name) {
      // Bun reports the watched root's own deletion (branch switch, rm -rf) as a nameless event and never emits "error".
      stopLoudly(watchRootLostMessage(opts.dir))
      return
    }
    const rel = path.relative(root, path.join(opts.dir, name.toString()))
    if (rel.startsWith("..") || path.isAbsolute(rel)) return
    clearTimeout(timers.get(rel))
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel)
        void scan(rel).catch((error) => UI.println(watchScanErrorMessage(rel, error)))
      }, 300),
    )
  })
  watcher.on("error", (error) => stopLoudly(watchStopMessage(error)))
  UI.println(`Watching ${opts.dir} for AI! and AI? comments (${opts.dryRun ? "dry run, " : ""}mode ${opts.mode}). Press Ctrl+C to stop.`)
  const stop = () => {
    stopping = true
    stopRun(current, queue, finish)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  await done
  watcher.close()
  for (const timer of timers.values()) clearTimeout(timer)
}
