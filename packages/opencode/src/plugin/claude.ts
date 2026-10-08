import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { Global } from "@yukioshi/core/global"
import { ConfigMarkdown as ConfigMarkdownCore } from "@yukioshi/core/config/markdown"

// Installing skills, commands, and agents from Claude Code plugins and marketplaces.
// A Claude Code plugin repository is treated purely as data:
// - skills/ are installed as skills
// - commands/ are sanitized into YukiOshi commands (Markdown with frontmatter, $ARGUMENTS)
// - agents/ are sanitized into YukiOshi agents (mapping known fields, dropping unknown ones)
// - hooks/hooks.json and .mcp.json are NEVER enabled or installed (since they run arbitrary programs).
//   They are extracted and reported as "not installed: runs programs" with the commands they would run.
// - Cloned safely: --depth 1, protocol allowlist, no hooks, no submodules, symlinks removed, .git dropped.

export const META = ".yukioshi-plugin.json"
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const KNOWN_AGENT_KEYS = new Set([
  "description",
  "model",
  "variant",
  "mode",
  "hidden",
  "color",
  "steps",
  "permissions",
  "permission",
  "disabled",
  "disable",
  "temperature",
  "top_p",
])

export const KNOWN_COMMAND_KEYS = new Set([
  "description",
  "agent",
  "model",
  "variant",
  "subtask",
])

export type SkippedProgram = {
  event?: string
  name?: string
  command: string
}

export type InstalledPlugin = {
  name: string
  url: string
  marketplace?: string
  directory: string
  commands: string[]
  agents: string[]
  skills: string[]
  droppedFields: Record<string, string[]>
  skippedHooks: SkippedProgram[]
  skippedMcp: SkippedProgram[]
  installedAt?: string
}

export type MarketplacePluginItem = {
  name: string
  description?: string
  source: string | { url?: string; path?: string }
}

export type MarketplaceListing = {
  type: "marketplace"
  name: string
  description?: string
  url: string
  plugins: MarketplacePluginItem[]
}

export type AddResult =
  | { type: "plugin"; plugin: InstalledPlugin }
  | MarketplaceListing

export const root = () => path.join(Global.Path.config, "plugins")

export function nameFromUrl(url: string): string {
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
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    await visit(file, entry)
    if (entry.isDirectory()) await walk(file, visit)
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false)
}

function extractHooksFromJson(data: unknown): SkippedProgram[] {
  const results: SkippedProgram[] = []
  if (!data || typeof data !== "object") return results

  function traverse(node: unknown, currentEvent: string) {
    if (!node) return
    if (Array.isArray(node)) {
      for (const item of node) traverse(item, currentEvent)
      return
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>
      if (typeof obj.command === "string" && obj.command.trim()) {
        results.push({
          event: (typeof obj.event === "string" && obj.event) || (typeof obj.type === "string" && obj.type) || currentEvent || "hook",
          command: obj.command.trim(),
        })
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === "command") continue
        const nextEvent = currentEvent && currentEvent !== "hooks" ? currentEvent : key
        traverse(value, nextEvent)
      }
    }
  }

  traverse(data, "")
  // Deduplicate
  const seen = new Set<string>()
  return results.filter((item) => {
    const key = `${item.event}:${item.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractMcpFromJson(data: unknown): SkippedProgram[] {
  const results: SkippedProgram[] = []
  if (!data || typeof data !== "object") return results

  const rootObj = data as Record<string, unknown>
  const servers = (rootObj.mcpServers && typeof rootObj.mcpServers === "object" ? rootObj.mcpServers : rootObj) as Record<string, unknown>

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") continue
    const serverObj = cfg as Record<string, unknown>
    const cmd = typeof serverObj.command === "string" ? serverObj.command : ""
    if (!cmd) continue
    const args = Array.isArray(serverObj.args) ? serverObj.args.map(String).join(" ") : ""
    const full = args ? `${cmd} ${args}` : cmd
    results.push({ name, command: full })
  }

  return results
}

export async function assertInsideDirectory(rootDir: string, candidate: string, label = "Path"): Promise<string> {
  const trimmed = candidate.trim()
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`)
  }

  // 1. Refuse absolute paths (POSIX and Windows drive / UNC)
  if (path.isAbsolute(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(`${label} "${candidate}" cannot be an absolute path; must reside inside repository`)
  }

  // 2. Refuse ".." path segments
  const segments = trimmed.split(/[\\/]/)
  if (segments.includes("..")) {
    throw new Error(`${label} "${candidate}" cannot contain ".." segments; must reside inside repository`)
  }

  // 3. Resolve candidate against root directory
  const resolved = path.resolve(rootDir, trimmed)

  // 4. Compare with path.relative
  const rel = path.relative(rootDir, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} "${candidate}" resolves outside repository`)
  }

  // 5. Check if it exists
  const stat = await fs.lstat(resolved).catch(() => undefined)
  if (!stat) {
    throw new Error(`${label} "${candidate}" does not exist in repository`)
  }

  // 6. Refuse symlinks directly
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} "${candidate}" is a symbolic link; symlinks are not allowed`)
  }

  // 7. Check fs.realpath on both sides to guard against any symlink escapes in parent segments
  const realRoot = await fs.realpath(rootDir)
  const realTarget = await fs.realpath(resolved)
  const realRel = path.relative(realRoot, realTarget)
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`${label} "${candidate}" resolves outside repository via symlink`)
  }

  return resolved
}

async function resolveInsideClone(opts: {
  clone: string
  candidate: string
  pluginName: string
  symlinksRemoved: Set<string>
}): Promise<string> {
  const { clone, candidate, pluginName, symlinksRemoved } = opts
  const trimmed = candidate.trim()

  // 1. Refuse absolute paths (POSIX and Windows drive / UNC)
  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    throw new Error(
      `Plugin source "${candidate}" for "${pluginName}" cannot be an absolute path; marketplace plugins must reside inside the repository`,
    )
  }

  // 2. Refuse ".." segments
  const segments = trimmed.split(/[\\/]/)
  if (segments.includes("..")) {
    throw new Error(
      `Plugin source "${candidate}" for "${pluginName}" cannot contain ".." segments; marketplace plugins must reside inside the repository`,
    )
  }

  // 3. Resolve path against clone
  const resolved = path.resolve(clone, trimmed)

  // 4. Compare with path.relative
  const rel = path.relative(clone, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Plugin source "${candidate}" for "${pluginName}" resolves outside the marketplace repository clone`,
    )
  }

  // 5. Check if it was a removed symlink or inside one
  for (const sym of symlinksRemoved) {
    if (resolved === sym || resolved.startsWith(sym + path.sep)) {
      throw new Error(
        `Plugin source "${candidate}" for "${pluginName}" is a symbolic link; symlinks are not allowed`,
      )
    }
  }

  // 6. Check if it exists on disk
  const stat = await fs.lstat(resolved).catch(() => undefined)
  if (!stat) {
    throw new Error(
      `Plugin directory "${candidate}" for "${pluginName}" does not exist in marketplace repository`,
    )
  }

  // 7. Refuse symbolic link
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Plugin source "${candidate}" for "${pluginName}" is a symbolic link; symlinks are not allowed`,
    )
  }

  // 8. Check fs.realpath on both sides to guard against symlink escapes
  const realClone = await fs.realpath(clone)
  const realTarget = await fs.realpath(resolved)
  const realRel = path.relative(realClone, realTarget)
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(
      `Plugin source "${candidate}" for "${pluginName}" resolves outside the marketplace repository clone via symlink`,
    )
  }

  return resolved
}

async function findHooks(dir: string, manifest?: Record<string, unknown>): Promise<SkippedProgram[]> {
  const list: SkippedProgram[] = []
  const candidates = [
    path.join(dir, "hooks", "hooks.json"),
    path.join(dir, "hooks.json"),
    path.join(dir, ".claude-plugin", "hooks.json"),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const content = await fs.readFile(candidate, "utf8").catch(() => "")
      try {
        const json = JSON.parse(content)
        list.push(...extractHooksFromJson(json))
      } catch {}
    }
  }
  if (manifest && manifest.hooks) {
    list.push(...extractHooksFromJson(manifest.hooks))
  }
  return list
}

async function findMcp(dir: string, manifest?: Record<string, unknown>): Promise<SkippedProgram[]> {
  const list: SkippedProgram[] = []
  const candidates = [
    path.join(dir, ".mcp.json"),
    path.join(dir, "mcp.json"),
    path.join(dir, ".claude-plugin", ".mcp.json"),
    path.join(dir, ".claude-plugin", "mcp.json"),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const content = await fs.readFile(candidate, "utf8").catch(() => "")
      try {
        const json = JSON.parse(content)
        list.push(...extractMcpFromJson(json))
      } catch {}
    }
  }
  if (manifest && (manifest.mcpServers || manifest.mcp)) {
    list.push(...extractMcpFromJson(manifest.mcpServers ?? manifest.mcp))
  }
  return list
}

async function parseMarketplace(dir: string): Promise<{ name?: string; description?: string; plugins: MarketplacePluginItem[] } | undefined> {
  const candidates = [
    path.join(dir, ".claude-plugin", "marketplace.json"),
    path.join(dir, "marketplace.json"),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const text = await fs.readFile(candidate, "utf8").catch(() => "")
      try {
        const json = JSON.parse(text)
        const plugins: MarketplacePluginItem[] = []
        if (Array.isArray(json.plugins)) {
          for (const item of json.plugins) {
            if (item && typeof item === "object" && typeof item.name === "string") {
              plugins.push({
                name: item.name,
                description: item.description,
                source: item.source ?? `./plugins/${item.name}`,
              })
            }
          }
        } else if (json.plugins && typeof json.plugins === "object") {
          for (const [key, val] of Object.entries(json.plugins)) {
            if (val && typeof val === "object") {
              const itemObj = val as Record<string, unknown>
              plugins.push({
                name: key,
                description: typeof itemObj.description === "string" ? itemObj.description : undefined,
                source: (itemObj.source as string | { url?: string; path?: string }) ?? `./plugins/${key}`,
              })
            } else if (typeof val === "string") {
              plugins.push({ name: key, source: val })
            }
          }
        }
        return {
          name: json.name,
          description: json.description,
          plugins,
        }
      } catch {}
    }
  }
  return undefined
}

async function installFromDirectory(input: {
  dir: string
  name?: string
  url: string
  marketplaceUrl?: string
}): Promise<InstalledPlugin> {
  const dir = input.dir
  let manifest: Record<string, unknown> | undefined
  const manifestPaths = [
    path.join(dir, ".claude-plugin", "plugin.json"),
    path.join(dir, "plugin.json"),
  ]
  for (const p of manifestPaths) {
    if (await exists(p)) {
      const text = await fs.readFile(p, "utf8").catch(() => "")
      try {
        manifest = JSON.parse(text)
        break
      } catch {}
    }
  }

  const rawName = input.name ?? (typeof manifest?.name === "string" ? manifest.name : undefined) ?? nameFromUrl(input.url)
  const name = rawName.trim()
  if (!NAME.test(name)) {
    throw new Error(`Invalid plugin name "${name}"; use letters, digits, ".", "_" or "-" (pass --name)`)
  }

  const pluginsRoot = root()
  const target = path.join(pluginsRoot, name)
  if (await exists(target)) {
    throw new Error(`A plugin named "${name}" is already installed; remove it first (yukioshi plugin remove ${name})`)
  }

  await fs.mkdir(pluginsRoot, { recursive: true })
  const stage = await fs.mkdtemp(path.join(pluginsRoot, ".plugin-stage-"))

  try {
    // 1. Blocked hooks and MCP (never installed)
    const skippedHooks = await findHooks(dir, manifest)
    const skippedMcp = await findMcp(dir, manifest)

    // 2. Process skills
    const installedSkills: string[] = []
    const skillCandidates = [
      path.join(dir, "skills"),
      path.join(dir, "skill"),
    ]
    let skillsSourceDir: string | undefined
    for (const sc of skillCandidates) {
      if (await exists(sc) && (await fs.stat(sc)).isDirectory()) {
        skillsSourceDir = sc
        break
      }
    }

    if (skillsSourceDir) {
      const destSkills = path.join(stage, "skills")
      await fs.mkdir(destSkills, { recursive: true })
      const entries = await fs.readdir(skillsSourceDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subSrc = path.join(skillsSourceDir, entry.name)
        const subDest = path.join(destSkills, entry.name)
        await fs.cp(subSrc, subDest, { recursive: true })
        // Check for SKILL.md
        const skillMd = path.join(subDest, "SKILL.md")
        if (await exists(skillMd)) {
          const content = await fs.readFile(skillMd, "utf8").catch(() => "")
          const parsed = ConfigMarkdownCore.parseOption(content)
          let skillName = entry.name
          if (parsed && typeof parsed.data.name === "string" && parsed.data.name.trim()) {
            skillName = parsed.data.name.trim()
          } else {
            // Inject name if missing
            const updated = matter.stringify(parsed ? parsed.content : content, {
              ...(parsed ? parsed.data : {}),
              name: skillName,
            })
            await fs.writeFile(skillMd, updated)
          }
          installedSkills.push(skillName)
        }
      }
    } else {
      // Check for single root SKILL.md
      const rootSkill = path.join(dir, "SKILL.md")
      if (await exists(rootSkill)) {
        const destSkills = path.join(stage, "skills", name)
        await fs.mkdir(destSkills, { recursive: true })
        await fs.cp(rootSkill, path.join(destSkills, "SKILL.md"))
        const content = await fs.readFile(rootSkill, "utf8").catch(() => "")
        const parsed = ConfigMarkdownCore.parseOption(content)
        const skillName = (parsed && typeof parsed.data.name === "string" && parsed.data.name.trim()) || name
        if (!parsed || !parsed.data.name) {
          const updated = matter.stringify(parsed ? parsed.content : content, {
            ...(parsed ? parsed.data : {}),
            name: skillName,
          })
          await fs.writeFile(path.join(destSkills, "SKILL.md"), updated)
        }
        installedSkills.push(skillName)
      }
    }

    // 3. Process commands
    const installedCommands: string[] = []
    const cmdCandidates = [
      path.join(dir, "commands"),
      path.join(dir, "command"),
    ]
    let cmdSourceDir: string | undefined
    for (const cc of cmdCandidates) {
      if (await exists(cc) && (await fs.stat(cc)).isDirectory()) {
        cmdSourceDir = cc
        break
      }
    }

    if (cmdSourceDir) {
      const destCmd = path.join(stage, "commands")
      await fs.mkdir(destCmd, { recursive: true })
      const entries = await fs.readdir(cmdSourceDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const fileSrc = path.join(cmdSourceDir, entry.name)
        const text = await fs.readFile(fileSrc, "utf8").catch(() => "")
        const parsed = ConfigMarkdownCore.parse(text)
        const data: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(parsed.data)) {
          if (KNOWN_COMMAND_KEYS.has(k)) data[k] = v
        }
        const cmdName = entry.name.replace(/\.md$/, "")
        const destFile = path.join(destCmd, entry.name)
        const sanitized = matter.stringify(parsed.content.trim(), data)
        await fs.writeFile(destFile, sanitized)
        installedCommands.push(cmdName)
      }
    }

    // 4. Process agents
    const installedAgents: string[] = []
    const droppedFields: Record<string, string[]> = {}
    const agentCandidates = [
      path.join(dir, "agents"),
      path.join(dir, "agent"),
    ]
    let agentSourceDir: string | undefined
    for (const ac of agentCandidates) {
      if (await exists(ac) && (await fs.stat(ac)).isDirectory()) {
        agentSourceDir = ac
        break
      }
    }

    if (agentSourceDir) {
      const destAgent = path.join(stage, "agents")
      await fs.mkdir(destAgent, { recursive: true })
      const entries = await fs.readdir(agentSourceDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const fileSrc = path.join(agentSourceDir, entry.name)
        const text = await fs.readFile(fileSrc, "utf8").catch(() => "")
        const parsed = ConfigMarkdownCore.parse(text)
        const data: Record<string, unknown> = {}
        const dropped: string[] = []
        for (const [k, v] of Object.entries(parsed.data)) {
          if (KNOWN_AGENT_KEYS.has(k)) {
            data[k] = v
          } else if (k !== "name") {
            dropped.push(k)
          }
        }
        if (data.mode === undefined) {
          data.mode = "subagent"
        }
        const agentName = entry.name.replace(/\.md$/, "")
        if (dropped.length > 0) {
          droppedFields[agentName] = dropped
        }
        const destFile = path.join(destAgent, entry.name)
        const sanitized = matter.stringify(parsed.content.trim(), data)
        await fs.writeFile(destFile, sanitized)
        installedAgents.push(agentName)
      }
    }

    // Validate that we found at least something
    if (installedSkills.length === 0 && installedCommands.length === 0 && installedAgents.length === 0) {
      throw new Error("This repository has no skills, commands, or agents to install")
    }

    // Write installation metadata
    const meta: InstalledPlugin = {
      name,
      url: input.url,
      marketplace: input.marketplaceUrl,
      directory: target,
      commands: installedCommands,
      agents: installedAgents,
      skills: installedSkills,
      droppedFields,
      skippedHooks,
      skippedMcp,
      installedAt: new Date().toISOString(),
    }
    await fs.writeFile(path.join(stage, META), JSON.stringify(meta, null, 2) + "\n")

    // Move atomically to destination
    await fs.rename(stage, target)
    return meta
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export async function add(input: {
  url: string
  plugin?: string
  name?: string
}): Promise<AddResult> {
  const rawUrl = input.url.trim()
  if (!rawUrl || rawUrl.startsWith("-")) {
    throw new Error(`Not a git URL: ${input.url}`)
  }

  const tempRoot = path.join(Global.Path.config, ".plugin-temp")
  await fs.mkdir(tempRoot, { recursive: true })
  const temp = await fs.mkdtemp(path.join(tempRoot, "clone-"))

  try {
    const clone = path.join(temp, "repo")
    const result = await git(
      ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--no-recurse-submodules", "--", rawUrl, clone],
      temp,
    )
    if (result.code !== 0) {
      throw new Error(`git clone failed: ${result.err.trim() || `exit ${result.code}`}`)
    }

    const symlinksRemoved = new Set<string>()
    await fs.rm(path.join(clone, ".git"), { recursive: true, force: true })
    await walk(clone, async (file, entry) => {
      if (entry.isSymbolicLink()) {
        symlinksRemoved.add(path.resolve(file))
        await fs.rm(file, { force: true })
      }
    })

    // Check if this repository is a marketplace
    const marketplace = await parseMarketplace(clone)
    if (marketplace) {
      const marketplaceName = marketplace.name ?? nameFromUrl(rawUrl)
      if (!input.plugin) {
        return {
          type: "marketplace",
          name: marketplaceName,
          description: marketplace.description,
          url: rawUrl,
          plugins: marketplace.plugins,
        }
      }

      const match = marketplace.plugins.find(
        (p) => p.name.toLowerCase() === input.plugin!.toLowerCase(),
      )
      if (!match) {
        throw new Error(
          `Plugin "${input.plugin}" not found in marketplace "${marketplaceName}". Available plugins: ${marketplace.plugins.map((p) => p.name).join(", ") || "none"}`,
        )
      }

      let source = match.source
      let isExplicitLocalPath = false
      let isExplicitExternalUrl = false

      if (typeof source === "object" && source !== null) {
        if (typeof source.path === "string" && source.path.trim()) {
          source = source.path.trim()
          isExplicitLocalPath = true
        } else if (typeof source.url === "string" && source.url.trim()) {
          source = source.url.trim()
          isExplicitExternalUrl = true
        } else {
          source = ""
        }
      } else if (typeof source === "string") {
        source = source.trim()
      } else {
        source = ""
      }

      if (!source) {
        source = `./plugins/${match.name}`
        isExplicitLocalPath = true
      }

      if (source.startsWith("file:") || source.startsWith("file://")) {
        throw new Error(
          `Marketplace plugin source "${source}" for "${match.name}" cannot use the file:// protocol`,
        )
      }

      const isExternalGit =
        !isExplicitLocalPath &&
        (isExplicitExternalUrl ||
          source.startsWith("https://") ||
          source.startsWith("http://") ||
          source.startsWith("git://") ||
          source.startsWith("ssh://") ||
          source.startsWith("git@") ||
          source.endsWith(".git"))

      if (!isExternalGit) {
        const localPluginDir = await resolveInsideClone({
          clone,
          candidate: source,
          pluginName: match.name,
          symlinksRemoved,
        })
        const installed = await installFromDirectory({
          dir: localPluginDir,
          name: input.name ?? match.name,
          url: rawUrl,
          marketplaceUrl: rawUrl,
        })
        return { type: "plugin", plugin: installed }
      }

      // External git repository for the plugin
      const subResult = await add({ url: source, name: input.name ?? match.name })
      if (subResult.type === "plugin") {
        subResult.plugin.marketplace = rawUrl
        const metaPath = path.join(subResult.plugin.directory, META)
        await fs.writeFile(metaPath, JSON.stringify(subResult.plugin, null, 2) + "\n")
      }
      return subResult
    }

    // Direct plugin repository
    const installed = await installFromDirectory({
      dir: clone,
      name: input.name,
      url: rawUrl,
    })
    return { type: "plugin", plugin: installed }
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

export async function list(): Promise<InstalledPlugin[]> {
  const dir = root()
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const result: InstalledPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(dir, entry.name)
    const meta = await fs
      .readFile(path.join(directory, META), "utf8")
      .then((text) => JSON.parse(text) as InstalledPlugin)
      .catch(() => undefined)
    if (meta) {
      result.push({ ...meta, directory })
    }
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name))
}

export async function remove(name: string): Promise<void> {
  const trimmed = name.trim()
  if (!NAME.test(trimmed)) {
    throw new Error(`Invalid plugin name "${name}"`)
  }
  const directory = path.join(root(), trimmed)
  const marked = await fs.stat(path.join(directory, META)).catch(() => undefined)
  if (!marked) {
    throw new Error(`No installed plugin named "${trimmed}"; see yukioshi plugin list`)
  }
  await fs.rm(directory, { recursive: true, force: true })
}

export * as ClaudePlugin from "./claude"
