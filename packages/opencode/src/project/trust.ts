import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { fileURLToPath } from "node:url"
import { Global } from "@yukioshi/core/global"
import { Flock } from "@yukioshi/core/util/flock"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "./instance-context"

const VERSION = 1 as const
const FILENAME = "project-trust.json"

type Entry = {
  path: string
  trustedAt: string
  /** Hash of the project's executable configuration when trust was granted. */
  fingerprint?: string
}

export type Status = "trusted" | "changed" | "untrusted"

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
    typeof value.trustedAt === "string" &&
    (!("fingerprint" in value) || typeof value.fingerprint === "string")
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

// Config files whose executable keys are covered by trust. Only these keys are fingerprinted,
// so editing ordinary settings such as `model` does not revoke trust.
const CONFIG_NAMES = new Set(["yukioshi.json", "yukioshi.jsonc", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"])
const EXECUTABLE_KEYS = ["hooks", "plugin", "mcp", "lsp", "formatter"] as const
const CONFIG_DIR = /(^|\/)\.(yukioshi|opencode)\//
const GENERATED = new Set([".gitignore", "package-lock.json", "bun.lock", "bun.lockb"])

async function projectFiles(root: string): Promise<string[]> {
  const listed = await (async () => {
    const git = Bun.spawn(["git", "ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    const text = await new Response(git.stdout).text()
    return (await git.exited) === 0 ? text : undefined
  })().catch(() => undefined)
  if (listed !== undefined) return listed.split("\0").filter(Boolean)
  // Not a git repository: only the root's own config files and config directories can apply.
  // Bun's glob does not combine brace alternatives with `**`, so scan each pattern separately.
  const patterns = ["*.json", "*.jsonc", ".yukioshi/**", ".opencode/**"]
  const found = await Promise.all(
    patterns.map((pattern) =>
      Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: true })).catch(() => []),
    ),
  )
  return found.flat()
}

function relevant(file: string) {
  const normalized = file.replaceAll("\\", "/")
  const name = path.posix.basename(normalized)
  if (CONFIG_NAMES.has(name)) return true
  if (!CONFIG_DIR.test(normalized)) return false
  // Agents, commands, and skills are Markdown prompts. YukiOshi itself writes .gitignore and the
  // dependency install output when it opens a trusted project; package.json stays covered.
  if (name.endsWith(".md") || GENERATED.has(name)) return false
  return !normalized.includes("/node_modules/")
}

function executableConfig(name: string, text: string): unknown {
  if (!CONFIG_NAMES.has(name)) return undefined
  const data = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined
  if (typeof data !== "object" || data === null) return undefined
  return EXECUTABLE_KEYS.map((key) => [key, data[key] ?? null])
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) strings(item, out)
  return out
}

/**
 * Files inside the project that executable config points at directly, such as a plugin path, a
 * hook script, or an MCP server entry point. Changing one of them changes what trust allowed.
 * Files those reference in turn (imports, sourced scripts) are not followed.
 */
async function referencedFiles(root: string, configDir: string, executable: unknown) {
  const found = new Set<string>()
  for (const text of strings(executable)) {
    for (const raw of text.split(/\s+/)) {
      const token = raw.replace(/^["']+|["']+$/g, "")
      if (!token || token.startsWith("-")) continue
      const candidate = token.startsWith("file://")
        ? (() => {
            try {
              return fileURLToPath(token)
            } catch {
              return undefined
            }
          })()
        : path.resolve(configDir, token)
      if (!candidate || !Filesystem.contains(root, candidate)) continue
      if ((await stat(candidate).catch(() => undefined))?.isFile()) found.add(candidate)
    }
  }
  return [...found].sort()
}

/** Hash of everything in the project that can make YukiOshi run commands once the project is trusted. */
export async function fingerprint(root: string) {
  const files = (await projectFiles(root)).filter(relevant).sort()
  const hash = createHash("sha256")
  const entry = (name: string, content: string) => hash.update(`${name.replaceAll("\\", "/")}\0${content}\0`)
  for (const file of files) {
    const absolute = path.join(root, file)
    const text = await readFile(absolute, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const executable = executableConfig(path.basename(file), text)
    if (executable === undefined) {
      entry(file, text)
      continue
    }
    entry(file, JSON.stringify(executable))
    for (const ref of await referencedFiles(root, path.dirname(absolute), executable)) {
      entry(`${file} -> ${path.relative(root, ref)}`, (await readFile(ref, "utf8").catch(() => "")) ?? "")
    }
  }
  return hash.digest("hex")
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

/**
 * Whether the project is trusted, and whether its executable configuration changed since then.
 * Reads take no lock: writes replace the store atomically, and a lock left by a process that
 * exited mid-read would otherwise stall the next start until the lock goes stale.
 */
export async function status(directory: string, options?: Options): Promise<Status> {
  const project = canonical(directory)
  const entry = (await read(storePath(options))).projects.find((item) => item.path === project)
  if (!entry) return "untrusted"
  if (entry.fingerprint === undefined || entry.fingerprint !== (await fingerprint(project))) return "changed"
  return "trusted"
}

export async function isTrusted(directory: string, options?: Options) {
  return (await status(directory, options)) === "trusted"
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
      if (trusted) {
        store.projects.push({ path: project, trustedAt: new Date().toISOString(), fingerprint: await fingerprint(project) })
      }
      await write(file, store)
    },
    { dir: path.join(state, "locks") },
  )
  return project
}

export * as ProjectTrust from "./trust"
