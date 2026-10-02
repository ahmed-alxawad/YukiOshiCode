import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { Global } from "@yukioshi/core/global"
import { Flock } from "@yukioshi/core/util/flock"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "./instance-context"

const VERSION = 1 as const
const FILENAME = "project-trust.json"

type Entry = {
  path: string
  trustedAt: string
}

type Store = {
  version: typeof VERSION
  projects: Entry[]
}

export type Options = {
  state?: string
}

function storePath(options?: Options) {
  return path.join(options?.state ?? Global.Path.state, FILENAME)
}

function empty(): Store {
  return { version: VERSION, projects: [] }
}

function isEntry(value: unknown): value is Entry {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "trustedAt" in value &&
    typeof value.trustedAt === "string"
  )
}

function decode(value: unknown): Store {
  if (typeof value !== "object" || value === null) return empty()
  const data = value as { version?: unknown; projects?: unknown }
  if (data.version !== VERSION || !Array.isArray(data.projects)) return empty()
  return {
    version: VERSION,
    projects: data.projects.filter(isEntry),
  }
}

async function read(file: string): Promise<Store> {
  return readFile(file, "utf8")
    .then((text) => decode(JSON.parse(text)))
    .catch(() => empty())
}

async function write(file: string, store: Store) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

export function canonical(directory: string) {
  return Filesystem.resolve(directory)
}

export function root(ctx: Pick<InstanceContext, "directory" | "worktree">) {
  return canonical(ctx.worktree === "/" ? ctx.directory : ctx.worktree)
}

/** Resolve a repository trust boundary without loading any repository configuration. */
export async function resolveRoot(directory: string) {
  const opened = canonical(directory)
  let current = opened
  while (true) {
    const git = await stat(path.join(current, ".git")).catch(() => undefined)
    if (git) return canonical(current)
    const parent = path.dirname(current)
    if (parent === current) return opened
    current = parent
  }
}

export async function isTrusted(directory: string, options?: Options) {
  const project = canonical(directory)
  const file = storePath(options)
  return Flock.withLock(
    `project-trust:${file}`,
    async () => (await read(file)).projects.some((entry) => entry.path === project),
    { dir: path.join(options?.state ?? Global.Path.state, "locks") },
  )
}

export async function set(directory: string, trusted: boolean, options?: Options) {
  const project = canonical(directory)
  const state = options?.state ?? Global.Path.state
  const file = storePath(options)
  await Flock.withLock(
    `project-trust:${file}`,
    async () => {
      const store = await read(file)
      store.projects = store.projects.filter((entry) => entry.path !== project)
      if (trusted) store.projects.push({ path: project, trustedAt: new Date().toISOString() })
      await write(file, store)
    },
    { dir: path.join(state, "locks") },
  )
  return project
}

export * as ProjectTrust from "./trust"
