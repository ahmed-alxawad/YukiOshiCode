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

async function skillNames(dir: string) {
  const names: string[] = []
  const realDir = await fs.realpath(dir).catch(() => dir)
  await walk(dir, async (file, entry) => {
    if (!entry.isFile() || entry.name !== "SKILL.md") return
    const realFile = await fs.realpath(file).catch(() => undefined)
    if (!realFile || path.relative(realDir, realFile).startsWith("..")) return
    const text = await fs.readFile(file, "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const declared = match ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(match[1])?.[1] : undefined
    if (declared && (declared.includes("/") || declared.includes("\\") || declared.includes(".."))) return
    names.push(declared ?? path.basename(path.dirname(file)))
  })
  return names
}

export async function add(input: { url: string; name?: string }): Promise<Installed> {
  const url = input.url.trim()
  if (!url || url.startsWith("-")) throw new Error(`Not a git URL: ${input.url}`)
  const name = input.name ?? nameFromUrl(url)
  if (!NAME.test(name)) throw new Error(`Invalid skill name "${name}"; use letters, digits, ".", "_" or "-" (pass --name)`)

  const skills = root()
  const target = path.join(skills, name)
  if (await fs.stat(target).catch(() => undefined))
    throw new Error(`A skill source named "${name}" is already installed; remove it first (yukioshi skill remove ${name})`)

  await fs.mkdir(skills, { recursive: true })
  const temp = await fs.mkdtemp(path.join(path.dirname(skills), ".skill-install-"))
  try {
    const clone = path.join(temp, "repo")
    const result = await git(
      ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--no-recurse-submodules", "--", url, clone],
      temp,
    )
    if (result.code !== 0) throw new Error(`git clone failed: ${result.err.trim() || `exit ${result.code}`}`)

    await fs.rm(path.join(clone, ".git"), { recursive: true, force: true })
    await walk(clone, async (file, entry) => {
      if (entry.isSymbolicLink()) await fs.rm(file, { force: true })
    })

    const found = await skillNames(clone)
    if (found.length === 0) throw new Error("This repository has no SKILL.md, so there is nothing to install")

    const meta: InstalledSource = { url, name, skills: found }
    await fs.writeFile(path.join(clone, META), JSON.stringify(meta, null, 2) + "\n")
    await fs.rename(clone, target)
    return { ...meta, directory: target }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

export async function list(): Promise<Installed[]> {
  const dir = root()
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
export async function remove(name: string) {
  if (!NAME.test(name)) throw new Error(`Invalid skill name "${name}"`)
  const directory = path.join(root(), name)
  const marked = await fs.stat(path.join(directory, META)).catch(() => undefined)
  if (!marked) throw new Error(`No installed skill source named "${name}"; see yukioshi skill list`)
  await fs.rm(directory, { recursive: true, force: true })
}

export * as SkillInstall from "./install"
