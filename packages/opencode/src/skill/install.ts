import fs from "fs/promises"
import path from "path"
import { Global } from "@yukioshi/core/global"

// Installing skills from git. A skill is only Markdown (SKILL.md plus files it references), so the
// cloned repository is treated as data: nothing in it is ever executed, git hooks are disabled,
// symlinks are removed (so a skill cannot point at files outside its folder), and the .git folder is
// dropped after cloning.

const META = ".yukioshi-skill.json"
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type InstalledSource = { url: string; name: string; skills: string[] }
export type Installed = InstalledSource & { directory: string }

export const root = () => path.join(Global.Path.config, "skills")

export function nameFromUrl(url: string) {
  const last = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? ""
  return last.replace(/\.git$/, "")
}

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      // No scripts from the repository, no helper transports like ext::, no prompts.
      GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

async function walk(dir: string, visit: (file: string, entry: import("fs").Dirent) => Promise<void>) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    await visit(file, entry)
    if (entry.isDirectory()) await walk(file, visit)
  }
}

const MAX_REPO_SIZE = 50 * 1024 * 1024 // 50 MB

export function validateGitUrl(raw: string): string {
  const url = raw.trim()
  if (!url || url.startsWith("-")) {
    throw new Error(`Not a git URL: ${raw}`)
  }
  if (/^file:(?:\/\/)?/i.test(url)) {
    throw new Error(`Git URLs cannot use the file:// protocol: ${raw}`)
  }
  if (/[\s\r\n\x00-\x1f]/.test(url)) {
    throw new Error(`Git URL cannot contain whitespace or control characters: ${raw}`)
  }
  if (/:\/\/-/.test(url) || /@-/.test(url)) {
    throw new Error(`Git URL host cannot start with '-': ${raw}`)
  }
  return url
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  await walk(dir, async (file, entry) => {
    if (entry.isFile()) {
      const s = await fs.stat(file).catch(() => undefined)
      if (s) total += s.size
    }
  })
  return total
}

type Found = { name: string; dir: string }

async function skillDirs(dir: string): Promise<Found[]> {
  const found: Found[] = []
  const realDir = await fs.realpath(dir).catch(() => dir)
  await walk(dir, async (file, entry) => {
    if (entry.isSymbolicLink() || !entry.isFile() || entry.name !== "SKILL.md") return
    const lstat = await fs.lstat(file).catch(() => undefined)
    if (!lstat || lstat.isSymbolicLink() || !lstat.isFile()) return
    const realFile = await fs.realpath(file).catch(() => undefined)
    if (!realFile || path.relative(realDir, realFile).startsWith("..")) return
    const text = await fs.readFile(file, "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const declared = match ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(match[1])?.[1] : undefined
    if (declared && (declared.includes("/") || declared.includes("\\") || declared.includes("..") || !NAME.test(declared))) return
    const fallback = path.basename(path.dirname(file))
    if (!NAME.test(fallback)) return
    found.push({ name: declared ?? fallback, dir: path.dirname(file) })
  })
  return found
}

const MAX_FILES = 2000
const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

// An archive is checked from its listing before anything is extracted: no absolute paths, no "..",
// no links of any kind, and a cap on entry count and declared size.
export function checkArchiveListing(lines: { type: string; size: number; name: string }[]) {
  if (lines.length > MAX_FILES) throw new Error(`Archive has too many entries (max ${MAX_FILES})`)
  let total = 0
  for (const line of lines) {
    const name = line.name.replaceAll("\\", "/")
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."))
      throw new Error(`Archive entry escapes the target folder: ${line.name}`)
    if (line.type === "l" || line.type === "h") throw new Error(`Archive contains a link, which is not allowed: ${line.name}`)
    total += line.size
  }
  if (total > MAX_REPO_SIZE) throw new Error("Archive is too large (max 50 MB)")
}

async function extractArchive(file: string, dest: string) {
  const zip = /\.zip$/i.test(file)
  const useUnzip = zip && process.platform !== "win32"
  // Names come from the plain listing and types/sizes from the verbose one, so parsing does not depend on
  // GNU tar vs bsdtar vs unzip column layouts.
  const names = useUnzip ? await run(["unzip", "-Z1", "--", file], dest) : await run(["tar", zip ? "-tf" : "-tzf", file], dest)
  if (names.code !== 0) throw new Error(`Could not read archive: ${names.err.trim() || `exit ${names.code}`}`)
  const verbose = useUnzip ? await run(["unzip", "-Z", "--", file], dest) : await run(["tar", zip ? "-tvf" : "-tzvf", file], dest)
  if (verbose.code !== 0) throw new Error(`Could not read archive: ${verbose.err.trim() || `exit ${verbose.code}`}`)
  const nameList = names.out.split(/\r?\n/).filter((l) => l.length > 0)
  const detail = verbose.out.split(/\r?\n/).filter((l) => /^[-dlhrwxsc?][-rwxsStTl]{9}/.test(l))
  const lines: { type: string; size: number; name: string }[] = nameList.map((name, i) => {
    const d = detail[i]
    const size = d ? Number(/\s(\d+)\s+(?:[A-Z][a-z]{2}\s+\d|\d{4}-\d\d-\d\d|\d{2}-[A-Z][a-z]{2}-)/.exec(d)?.[1] ?? 0) : 0
    return { type: d?.[0] ?? "-", size, name }
  })
  for (const d of detail) if (/^[lh]/.test(d)) throw new Error(`Archive contains a link, which is not allowed: ${d}`)
  checkArchiveListing(lines)
  const out = path.join(dest, "repo")
  await fs.mkdir(out)
  const x = useUnzip
    ? await run(["unzip", "-q", "--", file, "-d", out], dest)
    : await run(["tar", zip ? "-xf" : "-xzf", file, "--no-same-owner", "-C", out], dest)
  if (x.code !== 0) throw new Error(`Could not extract archive: ${x.err.trim() || `exit ${x.code}`}`)
  return out
}

function isRemote(source: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^\s/@]+@[^\s/]+:/.test(source)
}

async function isGitDir(dir: string) {
  const has = (n: string) => fs.stat(path.join(dir, n)).then(() => true, () => false)
  return (await has(".git")) || ((await has("HEAD")) && (await has("objects")))
}

// Puts the source's files in `<temp>/repo` and returns that folder. Nothing is executed.
async function fetchSource(source: string, temp: string): Promise<string> {
  const clone = path.join(temp, "repo")
  const stat = isRemote(source) ? undefined : await fs.stat(source).catch(() => undefined)
  if (stat?.isFile()) {
    if (!ARCHIVE.test(source)) throw new Error("Not a supported archive (use .zip, .tar.gz or .tgz)")
    return extractArchive(path.resolve(source), temp)
  }
  if (stat?.isDirectory() && !(await isGitDir(source))) {
    const files = { count: 0 }
    await walk(source, async (_f, entry) => {
      if (entry.isFile()) files.count++
    })
    if (files.count > MAX_FILES) throw new Error(`Folder has too many files (max ${MAX_FILES})`)
    if ((await dirSize(source)) > MAX_REPO_SIZE) throw new Error("Folder is too large (max 50 MB)")
    await fs.cp(source, clone, { recursive: true })
    return clone
  }
  if (!stat && !isRemote(source) && ARCHIVE.test(source)) throw new Error(`File not found: ${source}`)
  const url = validateGitUrl(source)
  const result = await git(
    ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--no-recurse-submodules", "--", url, clone],
    temp,
  )
  if (result.code !== 0) throw new Error(`git clone failed: ${result.err.trim() || `exit ${result.code}`}`)
  return clone
}

export type Outcome = {
  source: string
  status: "installed" | "skipped" | "failed" | "found"
  name?: string
  skills: string[]
  reason?: string
}

export type AddManyInput = {
  sources: string[]
  name?: string
  select?: string[]
  force?: boolean
  listOnly?: boolean
  /** Install folder; defaults to the global skills folder. */
  root?: string
}

async function addOne(source: string, input: AddManyInput, skills: string): Promise<Outcome> {
  const name = input.name ?? nameFromUrl(source).replace(/\.(zip|tar\.gz|tgz)$/i, "")
  if (!input.listOnly && !NAME.test(name))
    throw new Error(`Invalid skill name "${name}"; use letters, digits, ".", "_" or "-" (pass --name)`)
  const target = path.join(skills, name)
  if (!input.listOnly) {
    const existing = await fs.stat(target).catch(() => undefined)
    const marked = existing && (await fs.stat(path.join(target, META)).catch(() => undefined))
    if (existing && !marked)
      throw new Error(`A folder named "${name}" exists that YukiOshi did not install; it will not be overwritten`)
    if (existing && !input.force)
      return {
        source,
        name,
        status: "skipped",
        skills: [],
        reason: `A skill source named "${name}" is already installed; remove it first (yukioshi skill remove ${name}) or use --force`,
      }
  }

  await fs.mkdir(skills, { recursive: true })
  const temp = await fs.mkdtemp(path.join(path.dirname(skills), ".skill-install-"))
  try {
    const clone = await fetchSource(source, temp)
    await fs.rm(path.join(clone, ".git"), { recursive: true, force: true })
    await walk(clone, async (file, entry) => {
      if (entry.isSymbolicLink()) await fs.rm(file, { force: true, recursive: true })
    })
    if ((await dirSize(clone)) > MAX_REPO_SIZE) throw new Error(`Repository is too large (max 50 MB)`)

    const all = await skillDirs(clone)
    if (all.length === 0) throw new Error("This repository has no SKILL.md, so there is nothing to install")
    const wanted = input.select?.length ? new Set(input.select) : undefined
    const chosen = wanted
      ? all.filter((item) => wanted.has(item.name) || wanted.has(path.basename(item.dir)))
      : all
    const names = chosen.map((item) => item.name)
    if (input.listOnly) return { source, name, status: "found", skills: all.map((item) => item.name) }
    if (chosen.length === 0)
      return { source, name, status: "skipped", skills: [], reason: "none of the selected skills are in this source" }

    let dir = clone
    if (wanted && chosen.length < all.length) {
      const keep = new Set(chosen.map((item) => item.dir))
      const drop = all.filter((item) => !keep.has(item.dir))
      const hasKept = (d: string) => [...keep].some((k) => k === d || k.startsWith(d + path.sep))
      dir = path.join(temp, "selected")
      await fs.cp(clone, dir, {
        recursive: true,
        filter: (src) => {
          for (const item of drop) {
            if (src === path.join(item.dir, "SKILL.md") && hasKept(item.dir)) return false
            if (src === item.dir && !hasKept(item.dir)) return false
          }
          return true
        },
      })
    }
    const meta: InstalledSource = { url: source, name, skills: names }
    await fs.writeFile(path.join(dir, META), JSON.stringify(meta, null, 2) + "\n")
    const old = path.join(temp, "old")
    if (await fs.stat(target).catch(() => undefined)) await fs.rename(target, old)
    await fs.rename(dir, target)
    return { source, name, status: "installed", skills: names }
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

// Installs many sources (git URLs, local folders, .zip/.tar.gz archives). One failing source never
// stops the others; each gets an outcome row.
export async function addMany(input: AddManyInput): Promise<Outcome[]> {
  for (const item of input.select ?? [])
    if (!NAME.test(item)) throw new Error(`Invalid skill name "${item}" in --select`)
  if (input.name && input.sources.length > 1) throw new Error("--name can only be used with a single source")
  const skills = input.root ?? root()
  const outcomes: Outcome[] = []
  for (const source of input.sources) {
    outcomes.push(
      await addOne(source, input, skills).catch(
        (error): Outcome => ({
          source,
          status: "failed",
          skills: [],
          reason: error instanceof Error ? error.message : String(error),
        }),
      ),
    )
  }
  for (const item of input.select ?? [])
    if (!outcomes.some((o) => o.skills.includes(item)))
      outcomes.push({ source: `--select ${item}`, status: "failed", skills: [], reason: "skill not found in any source" })
  return outcomes
}

export async function add(input: { url: string; name?: string }): Promise<Installed> {
  const [outcome] = await addMany({ sources: [input.url], name: input.name })
  if (outcome.status !== "installed") throw new Error(outcome.reason ?? "install failed")
  return { url: input.url, name: outcome.name!, skills: outcome.skills, directory: path.join(root(), outcome.name!) }
}

export async function list(base?: string): Promise<Installed[]> {
  const dir = base ?? root()
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const result: Installed[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(dir, entry.name)
    const meta = await fs
      .readFile(path.join(directory, META), "utf8")
      .then((text) => JSON.parse(text) as InstalledSource)
      .catch(() => undefined)
    if (meta) result.push({ ...meta, directory })
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name))
}

// Only folders YukiOshi installed itself (marked by the metadata file) can be removed, so a typo
// can never delete a skill folder the user wrote by hand.
export async function remove(name: string, base?: string) {
  if (!NAME.test(name)) throw new Error(`Invalid skill name "${name}"`)
  const directory = path.join(base ?? root(), name)
  const marked = await fs.stat(path.join(directory, META)).catch(() => undefined)
  if (!marked) throw new Error(`No installed skill source named "${name}"; see yukioshi skill list`)
  await fs.rm(directory, { recursive: true, force: true })
}

export * as SkillInstall from "./install"
