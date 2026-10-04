import { LayerNode } from "@yukioshi/core/effect/layer-node"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@yukioshi/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@yukioshi/core/global"
import { SkillPlugin } from "@yukioshi/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@yukioshi/core/fs-util"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { FrontmatterError } from "@yukioshi/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@yukioshi/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { Filesystem } from "@/util/filesystem"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const YUKIOSHI_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const BUILTIN_SKILL_PATTERN = "**/SKILL.md"

// Bundled, Apache-2.0-licensed skills shipped with YukiOshi Code (design, engineering,
// productivity, skill-creator, web-artifacts-builder, bugfix, disaster, nightmare -
// see skills/NOTICE for provenance). Resolved relative to this source file so it
// works for `bun run src/index.ts`. Compiled binaries embed the same files via the
// build-generated `yukioshi-skills.gen.ts` module and extract them to the cache.
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url))

// Set once the embedded skills of a compiled binary are extracted, so isBuiltin() recognizes them.
let extractedSkillsDir: string | undefined

// One extraction per process: every instance that starts at the same time shares it, so two
// extractions can never race over the same folders.
const extractions = new Map<string, Promise<string | undefined>>()

const extractEmbeddedSkills = (cache: string) =>
  Effect.promise(() => {
    const existing = extractions.get(cache)
    if (existing) return existing
    const started = Effect.runPromise(extractEmbeddedSkillsOnce(cache))
    extractions.set(cache, started)
    return started
  })

const extractEmbeddedSkillsOnce = Effect.fnUntraced(function* (cache: string) {
  const embedded = yield* Effect.promise(() =>
    // @ts-expect-error - generated file at build time
    import("yukioshi-skills.gen.ts")
      .then((module) => module.default as Record<string, string>)
      .catch(() => undefined),
  )
  if (!embedded) return undefined
  const target = path.join(cache, "skills", InstallationVersion)
  const marker = path.join(target, ".extracted")
  const extracted = yield* Effect.promise(async () => {
    if (await Bun.file(marker).exists()) return true
    // Extract into a private directory, then rename, so concurrent instances never see a partial tree.
    const staging = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.rm(staging, { recursive: true, force: true })
    for (const [file, source] of Object.entries(embedded)) {
      const dest = path.join(staging, file)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await Bun.write(dest, Bun.file(source))
      if (/\.(sh|py)$/.test(file)) await fs.chmod(dest, 0o755)
    }
    await Bun.write(path.join(staging, ".extracted"), InstallationVersion)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target).catch(() => fs.rm(staging, { recursive: true, force: true }))
    return Bun.file(marker).exists()
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to extract built-in skills", { cause }).pipe(Effect.as(false))))
  if (!extracted) return undefined
  extractedSkillsDir = target
  return target
})

// Built-in skill that ships with YukiOshi Code. The model's intuition for what a
// yukioshi.json (or legacy opencode.json) should look like is often wrong, and YukiOshi hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch YukiOshi's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_YUKIOSHI_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_YUKIOSHI_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating YukiOshi's own configuration: yukioshi.json, yukioshi.jsonc, files under .yukioshi/, or files under ~/.config/yukioshi/. Legacy opencode.json, opencode.jsonc, and .opencode/ locations are also supported. Also use when creating or fixing YukiOshi agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring YukiOshi itself."
const CUSTOMIZE_YUKIOSHI_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type SkillScope = "builtin" | "global" | "project" | "configured" | "remote"

type DiscoveredSkill = {
  path: string
  scope: SkillScope
}

type DiscoveryState = {
  matches: DiscoveredSkill[]
  dirs: string[]
}

type ScanState = {
  matches: Map<string, SkillScope>
  dirs: Set<string>
}

export const PROJECT_NAMESPACE = "project:"

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveredSkill,
  events: EventV2Bridge.Service["Service"],
) {
  const match = discovered.path
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  const name = discovered.scope === "project" ? `${PROJECT_NAMESPACE}${md.data.name}` : md.data.name

  if (state.skills[name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name,
      declared: md.data.name,
      existing: state.skills[name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[name] = {
    name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts: { dot?: boolean; scope: SkillScope; label?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      return Effect.logError(`failed to scan ${opts.label ?? opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  const resolvedRoot = FSUtil.resolve(root)
  for (const match of matches) {
    const resolvedMatch = yield* Effect.try({
      try: () => FSUtil.resolve(match),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to resolve discovered skill", { path: match, error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!resolvedMatch) continue
    if (!FSUtil.contains(resolvedRoot, resolvedMatch)) {
      yield* Effect.logWarning("ignored skill outside discovery root", { root, path: match, resolved: resolvedMatch })
      continue
    }
    const previous = state.matches.get(match)
    // If one physical path is reachable from both a global and a project search root, retain the
    // more restrictive project identity. This prevents an alias/symlink from escaping namespacing.
    if (!previous || opts.scope === "project") state.matches.set(match, opts.scope)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Map(), dirs: new Set() }

  const builtinDir = (yield* fsys.isDir(BUILTIN_SKILLS_DIR))
    ? BUILTIN_SKILLS_DIR
    : yield* extractEmbeddedSkills(global.cache)
  if (builtinDir) {
    yield* scan(state, builtinDir, BUILTIN_SKILL_PATTERN, { scope: "builtin" })
  }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    // Outside a git repository the walk can reach the home folder; its .claude and .agents folders hold
    // the user's global skills (scanned above), never project skills.
    const homeDirs = new Set(externalDirs.map((dir) => path.resolve(global.home, dir)))
    for (const root of upDirs) {
      if (homeDirs.has(path.resolve(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* ConfigPaths.directoryEntries(directory, worktree).pipe(
    Effect.provideService(FSUtil.Service, fsys),
    Effect.orDie,
  )
  const boundary = worktree === "/" ? directory : worktree
  for (const entry of configDirs) {
    const projectOwned =
      entry.scope === "project" ||
      (entry.scope === "explicit" && FSUtil.contains(Filesystem.resolve(boundary), Filesystem.resolve(entry.path)))
    yield* scan(state, entry.path, YUKIOSHI_SKILL_PATTERN, {
      scope: projectOwned ? "project" : "global",
      label: entry.scope,
    })
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    const lexical = path.resolve(dir)
    const scope =
      cfg.project_skill_paths?.includes(item) || FSUtil.contains(boundary, lexical) ? "project" : "configured"
    yield* scan(state, dir, SKILL_PATTERN, { scope })
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN, {
        scope: cfg.project_skill_urls?.includes(url) ? "project" : "remote",
      })
    }
  }

  return {
    matches: Array.from(state.matches, ([path, scope]) => ({ path, scope })),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the hardcoded built-in before disk discovery. Project skills use a separate
        // `project:` namespace, so a same-named project skill can never replace this entry.
        s.skills[CUSTOMIZE_YUKIOSHI_SKILL_NAME] = {
          name: CUSTOMIZE_YUKIOSHI_SKILL_NAME,
          description: CUSTOMIZE_YUKIOSHI_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_YUKIOSHI_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

/** True for the hardcoded customize-opencode skill and everything discovered from the bundled skills/ directory. */
export function isBuiltin(info: Pick<Info, "location">): boolean {
  return (
    info.location === "<built-in>" ||
    FSUtil.contains(BUILTIN_SKILLS_DIR, info.location) ||
    (extractedSkillsDir !== undefined && FSUtil.contains(extractedSkillsDir, info.location))
  )
}

// The list goes into every request, so keep each entry short: the full description and the skill's
// folder are returned by the skill tool when the model loads the skill.
const LISTED_DESCRIPTION_MAX = 300

function listedDescription(description: string) {
  if (description.length <= LISTED_DESCRIPTION_MAX) return description
  const cut = description.slice(0, LISTED_DESCRIPTION_MAX)
  const end = cut.lastIndexOf(" ")
  return (end > LISTED_DESCRIPTION_MAX / 2 ? cut.slice(0, end) : cut).trimEnd() + "…"
}

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${listedDescription(skill.description!)}</description>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
