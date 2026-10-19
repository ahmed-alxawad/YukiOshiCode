import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Global } from "@yukioshi/core/global"
import * as RunningTurns from "@/session/running"
import { TasksCommand } from "@/cli/cmd/tasks"
import { cliIt } from "../lib/cli-process"

const bunDir = path.dirname(process.execPath)
if (!process.env.PATH?.split(":").includes(bunDir)) {
  process.env.PATH = process.env.PATH ? `${bunDir}:${process.env.PATH}` : bunDir
}

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

// The test preload sets YUKIOSHI_DB=:memory:, so both processes get one shared database file instead.
async function tasks(home: string, args: string[]) {
  const bunPath = process.execPath
  const bunDir = path.dirname(bunPath)
  const pathEnv = process.env.PATH ? `${bunDir}:${process.env.PATH}` : bunDir
  const proc = Bun.spawn([bunPath, "run", entry, "tasks", ...args], {
    cwd: home,
    env: {
      ...process.env,
      PATH: pathEnv,
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
        const list = () => Effect.tryPromise(listP).pipe(Effect.orElseSucceed(() => ({ sessions: [] }) as Listing))

        let listing: Listing = { sessions: [] }
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          yield* Effect.sleep("250 millis")
          const current = yield* list()
          if (
            current.sessions.length === 1 &&
            current.sessions[0]!.state.includes("turn") &&
            current.sessions[0]!.sessionID.startsWith("ses_")
          ) {
            listing = current
            break
          }
        }
        expect(listing.sessions).toHaveLength(1)
        expect(listing.sessions[0]!.state).toContain("turn")
        expect(listing.sessions[0]!.sessionID.startsWith("ses_")).toBe(true)

        const sessionID = listing.sessions[0]!.sessionID
        let table = ""
        const tableDeadline = Date.now() + 30_000
        while (Date.now() < tableDeadline) {
          const res = yield* Effect.tryPromise(() => tasks(home, ["--all"])).pipe(Effect.orElseSucceed(() => ""))
          if (res.includes(sessionID)) {
            table = res
            break
          }
          yield* Effect.sleep("250 millis")
        }
        expect(table).toContain(sessionID)

        handle.interrupt()
        yield* handle.result

        let stoppedListing: Listing = { sessions: ["pending" as any] }
        const stopDeadline = Date.now() + 30_000
        while (Date.now() < stopDeadline) {
          yield* Effect.sleep("250 millis")
          const current = yield* list()
          if (current.sessions.length === 0) {
            stoppedListing = current
            break
          }
        }
        expect(stoppedListing.sessions).toEqual([])

        let empty = ""
        const emptyDeadline = Date.now() + 30_000
        while (Date.now() < emptyDeadline) {
          const res = yield* Effect.tryPromise(() => tasks(home, ["--all"])).pipe(Effect.orElseSucceed(() => ""))
          if (res === "No running sessions.\n") {
            empty = res
            break
          }
          yield* Effect.sleep("250 millis")
        }
        expect(empty).toBe("No running sessions.\n")
      }),
    120_000,
  )
})
