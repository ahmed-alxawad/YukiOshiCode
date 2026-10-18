import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Global } from "@yukioshi/core/global"
import * as RunningTurns from "@/session/running"
import { TasksCommand } from "@/cli/cmd/tasks"
import { cliIt } from "../lib/cli-process"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

// The test preload sets YUKIOSHI_DB=:memory:, so both processes get one shared database file instead.
async function tasks(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", entry, "tasks", ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PWD: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      YUKIOSHI_TEST_HOME: home,
      YUKIOSHI_DB: path.join(home, "sessions.db"),
      YUKIOSHI_PURE: "1",
      YUKIOSHI_DISABLE_PROJECT_CONFIG: "1",
      YUKIOSHI_AUTH_CONTENT: "{}",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`tasks ${args.join(" ")} exited ${code}: ${stderr}`)
  return stdout
}

const DEAD_PID = 2 ** 22 + 54321

describe("running-turn markers", () => {
  beforeEach(() => fs.rmSync(RunningTurns.dir(), { recursive: true, force: true }))
  afterEach(() => fs.rmSync(RunningTurns.dir(), { recursive: true, force: true }))

  test("a marked turn of a live process is listed, and clear removes it", () => {
    RunningTurns.mark("ses_live")
    expect(RunningTurns.live().map((m) => m.sessionID)).toEqual(["ses_live"])
    RunningTurns.clear("ses_live")
    expect(RunningTurns.live()).toEqual([])
  })

  test("a marker whose process is gone is ignored and removed", () => {
    fs.mkdirSync(RunningTurns.dir(), { recursive: true })
    const file = path.join(RunningTurns.dir(), "ses_dead.json")
    fs.writeFileSync(file, JSON.stringify({ sessionID: "ses_dead", pid: DEAD_PID, startedAt: Date.now() }))
    expect(RunningTurns.live()).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
  })

  test("clear does not remove a marker owned by another process", () => {
    fs.mkdirSync(RunningTurns.dir(), { recursive: true })
    const file = path.join(RunningTurns.dir(), "ses_other.json")
    fs.writeFileSync(file, JSON.stringify({ sessionID: "ses_other", pid: process.ppid, startedAt: Date.now() }))
    RunningTurns.clear("ses_other")
    expect(fs.existsSync(file)).toBe(true)
  })

  test("state directory lives under the state folder", () => {
    expect(RunningTurns.dir().startsWith(Global.Path.state)).toBe(true)
  })

  test("tasks has an --all option", () => {
    const options: string[] = []
    const fake: any = new Proxy({}, { get: () => (name: string) => (options.push(name), fake) })
    ;(TasksCommand as any).builder(fake)
    expect(options).toContain("all")
  })
})

type Listing = { sessions: Array<{ sessionID: string; state: string[]; project: string; title: string; ageMs: number }> }

describe("yukioshi tasks --all (real run in the background)", () => {
  cliIt.live(
    "lists a session whose turn is blocked on the model, then not after it is stopped",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const handle = yield* opencode.startRun("block forever", { env: { YUKIOSHI_DB: path.join(home, "sessions.db") } })
        const listP = async () => JSON.parse(await tasks(home, ["--all", "--format", "json"])) as Listing
        const list = () => Effect.promise(listP)

        // The run is still migrating the shared fresh database while we poll, so an early listing can fail
        // ("table already exists"); keep polling until the session shows up or the deadline passes.
        let listing: Listing = { sessions: [] }
        const deadline = Date.now() + 90_000
        while (listing.sessions.length === 0 && Date.now() < deadline) {
          yield* Effect.sleep("500 millis")
          listing = yield* Effect.tryPromise(listP).pipe(Effect.orElseSucceed(() => ({ sessions: [] }) as Listing))
        }
        expect(listing.sessions).toHaveLength(1)
        expect(listing.sessions[0]!.state).toContain("turn")
        expect(listing.sessions[0]!.sessionID.startsWith("ses_")).toBe(true)

        const table = yield* Effect.promise(() => tasks(home, ["--all"]))
        expect(table).toContain(listing.sessions[0]!.sessionID)

        handle.interrupt()
        yield* handle.result
        expect((yield* list()).sessions).toEqual([])
        const empty = yield* Effect.promise(() => tasks(home, ["--all"]))
        expect(empty).toBe("No running sessions.\n")
      }),
    120_000,
  )
})
