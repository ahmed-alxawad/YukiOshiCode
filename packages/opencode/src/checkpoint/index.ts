import { LayerNode } from "@yukioshi/core/effect/layer-node"
import type { ConfigCheckpointsV1 } from "@yukioshi/core/v1/config/checkpoints"
import { Context, Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"

const PREFIX = "refs/yukioshi/checkpoints/"

type GitResult = { stdout: string; status: number | null }

// Checkpoints must never run code from the repository: no hooks (e.g. post-index-change fires on index writes)
// and no fsmonitor command, whatever the repository or core.hooksPath says.
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]

function git(cwd: string, args: string[], env?: Record<string, string>): GitResult {
  const result = spawnSync("git", [...SAFE_CONFIG, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim())
  return { stdout: String(result.stdout), status: result.status }
}

function tryGit(cwd: string, args: string[], env?: Record<string, string>) {
  const result = spawnSync("git", [...SAFE_CONFIG, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" })
  return { stdout: String(result.stdout), stderr: String(result.stderr), status: result.status }
}

export function repositoryRoot(directory: string) {
  return git(directory, ["rev-parse", "--show-toplevel"]).stdout.trim()
}

export function hasWorkingTreeChanges(directory: string) {
  return Boolean(git(directory, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim())
}

function currentHead(directory: string) {
  const result = tryGit(directory, ["rev-parse", "HEAD"])
  return result.status === 0 ? result.stdout.trim() : undefined
}

function checkpointRef(sessionID: string) {
  return `${PREFIX}${sessionID}`
}

function checkpointMessage(prompt: string, sessionID: string, turn: number) {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() || "YukiOshi checkpoint"
  return `${firstLine}\n\nSession: ${sessionID}\nTurn: ${turn}`
}

// The turn counts checkpoints of this session only; commits already on the user's branch must not be counted.
function previousTurn(root: string, previous: string) {
  const message = git(root, ["show", "-s", "--format=%B", previous]).stdout
  return Number(/^Turn: (\d+)$/m.exec(message)?.[1] ?? 0)
}

export function createCheckpoint(input: { directory: string; sessionID: string; prompt: string; force?: boolean }) {
  const root = repositoryRoot(input.directory)
  if (!input.force && !hasWorkingTreeChanges(root)) return undefined
  const ref = checkpointRef(input.sessionID)
  const previous =
    tryGit(root, ["rev-parse", ref]).status === 0 ? git(root, ["rev-parse", ref]).stdout.trim() : undefined
  const parent = previous ?? currentHead(root)
  const temp = mkdtempSync(path.join(tmpdir(), "yukioshi-checkpoint-"))
  const index = path.join(temp, "index")
  try {
    const env = { GIT_INDEX_FILE: index }
    if (parent) git(root, ["read-tree", parent], env)
    git(root, ["add", "-A"], env)
    const tree = git(root, ["write-tree"], env).stdout.trim()
    const turn = (previous ? previousTurn(root, previous) : 0) + 1
    const args = ["commit-tree", tree]
    if (parent) args.push("-p", parent)
    args.push("-m", checkpointMessage(input.prompt, input.sessionID, turn))
    const commit = git(root, args, {
      ...env,
      GIT_AUTHOR_NAME: "YukiOshi",
      GIT_AUTHOR_EMAIL: "checkpoint@yukioshi.invalid",
      GIT_COMMITTER_NAME: "YukiOshi",
      GIT_COMMITTER_EMAIL: "checkpoint@yukioshi.invalid",
    })
    const hash = commit.stdout.trim()
    const update = ["update-ref", ref, hash]
    if (previous) update.push(previous)
    git(root, update)
    return { id: hash, ref, turn, root }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export type CheckpointInfo = {
  id: string
  ref: string
  sessionID: string
  time: number
  message: string
  files: string[]
}
export type CheckpointCreated = { id: string; ref: string; turn: number; root: string }

function refs(directory: string) {
  return git(directory, ["for-each-ref", "--format=%(refname)", PREFIX]).stdout.trim().split("\n").filter(Boolean)
}

export function listCheckpoints(directory: string, sessionID?: string): CheckpointInfo[] {
  const root = repositoryRoot(directory)
  const selected = sessionID ? [checkpointRef(sessionID)] : refs(root)
  const result: CheckpointInfo[] = []
  for (const ref of selected) {
    const commits = tryGit(root, ["rev-list", ref])
    if (commits.status !== 0) continue
    for (const id of commits.stdout.trim().split("\n").filter(Boolean)) {
      const message = git(root, ["show", "-s", "--format=%B", id]).stdout.trim()
      if (!message.includes("Session:") || !message.includes("Turn:")) continue
      const time = Number(git(root, ["show", "-s", "--format=%ct", id]).stdout.trim())
      const files = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", id])
        .stdout.trim()
        .split("\n")
        .filter(Boolean)
      result.push({ id, ref, sessionID: ref.slice(PREFIX.length), time, message, files })
    }
  }
  return result.sort((a, b) => b.time - a.time)
}

export function resolveCheckpointID(items: readonly Pick<CheckpointInfo, "id">[], prefix: string) {
  const value = prefix.trim().toLowerCase()
  if (value.length < 7) throw new Error("Checkpoint ids must be at least 7 characters.")
  if (!/^[0-9a-f]+$/.test(value)) throw new Error(`Checkpoint not found: ${prefix}`)
  const matches = [...new Set(items.map((item) => item.id).filter((id) => id.toLowerCase().startsWith(value)))]
  if (matches.length === 0) throw new Error(`Checkpoint not found: ${prefix}`)
  if (matches.length > 1)
    throw new Error(
      `Checkpoint id is ambiguous: ${prefix} (matches ${matches.map((id) => id.slice(0, 12)).join(", ")})`,
    )
  return matches[0]!
}

export function resolveCheckpoint(directory: string, prefix: string) {
  return resolveCheckpointID(listCheckpoints(directory), prefix)
}

export function showCheckpoint(directory: string, prefix: string) {
  const root = repositoryRoot(directory)
  const id = resolveCheckpointID(listCheckpoints(root), prefix)
  return git(root, ["show", "--format=fuller", "--stat", "--patch", id]).stdout
}

export function restoreCheckpoint(input: { directory: string; id: string; yes?: boolean; sessionID: string }) {
  const root = repositoryRoot(input.directory)
  const targetID = resolveCheckpointID(listCheckpoints(root), input.id)
  if (hasWorkingTreeChanges(root) && !input.yes)
    throw new Error("Unsaved changes exist. Re-run with --yes to restore after making a safety checkpoint.")
  const safety = createCheckpoint({
    directory: root,
    sessionID: input.sessionID,
    prompt: `Before restoring ${input.id}`,
    force: true,
  })
  if (!safety) throw new Error("Could not create the safety checkpoint.")
  const target = new Set(
    git(root, ["ls-tree", "-r", "--name-only", targetID]).stdout.trim().split("\n").filter(Boolean),
  )
  const current = git(root, ["ls-files"]).stdout.trim().split("\n").filter(Boolean)
  for (const file of current) if (!target.has(file)) rmSync(path.join(root, file), { force: true })
  for (const file of target) {
    const content = spawnSync("git", ["show", `${targetID}:${file}`], { cwd: root }).stdout
    const output = path.join(root, file)
    const parent = path.dirname(output)
    mkdirSync(parent, { recursive: true })
    writeFileSync(output, content)
  }
  return root
}

export function pruneCheckpoints(directory: string, olderThanMs: number) {
  const root = repositoryRoot(directory)
  const cutoff = Math.floor((Date.now() - olderThanMs) / 1000)
  let removed = 0
  for (const ref of refs(root)) {
    const timestamp = Number(git(root, ["show", "-s", "--format=%ct", ref]).stdout.trim())
    if (timestamp < cutoff) {
      git(root, ["update-ref", "-d", ref])
      removed++
    }
  }
  return removed
}

export interface Interface {
  readonly create: (input: { sessionID: string; prompt: string }) => Effect.Effect<CheckpointCreated | undefined, Error>
  readonly list: (sessionID?: string) => Effect.Effect<CheckpointInfo[], Error>
  readonly show: (id: string) => Effect.Effect<string, Error>
  readonly restore: (input: { id: string; yes?: boolean; sessionID: string }) => Effect.Effect<string, Error>
  readonly prune: (olderThanMs: number) => Effect.Effect<number, Error>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Checkpoint") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const run = <A>(fn: () => A) =>
      Effect.try({
        try: fn,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
    const enabled = Effect.map(config.get(), (value) => value.checkpoints?.enabled === true)
    const withRoot = <A>(fn: (root: string) => A) =>
      Effect.flatMap(InstanceState.context, (ctx) => run(() => fn(ctx.worktree)))
    return {
      create: (input) =>
        Effect.flatMap(enabled, (on) =>
          on ? withRoot((root) => createCheckpoint({ directory: root, ...input })) : Effect.succeed(undefined),
        ),
      list: (sessionID) => withRoot((root) => listCheckpoints(root, sessionID)),
      show: (id) => withRoot((root) => showCheckpoint(root, id)),
      restore: (input) => withRoot((root) => restoreCheckpoint({ directory: root, ...input })),
      prune: (olderThanMs) => withRoot((root) => pruneCheckpoints(root, olderThanMs)),
    } satisfies Interface
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node] })

export * as Checkpoint from "./index"
