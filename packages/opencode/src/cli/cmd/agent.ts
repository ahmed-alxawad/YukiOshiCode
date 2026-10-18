import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@yukioshi/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { requireTerminal } from "../needs-terminal"
import { ConfigAgentV1 } from "@yukioshi/core/v1/config/agent"
import { Glob } from "@yukioshi/core/util/glob"
import { isClaudeDir, withClaudeDirs } from "@/config/claude-agents"
import { ConfigMarkdown } from "@/config/markdown"
import { ConfigParse } from "@/config/parse"
import { configEntryNameFromPath } from "@/config/entry-name"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

export function agentTargetDirectory(
  input: { path: string } | { scope: "global" | "project"; worktree: string; globalConfig: string },
) {
  if ("path" in input) return path.join(input.path, "agents")
  const root = input.scope === "global" ? input.globalConfig : path.join(input.worktree, ".yukioshi")
  return path.join(root, "agents")
}

// --- `agent validate` / `agent show` helpers (exported for unit tests) ---

export interface AgentFileReport {
  file: string
  /** Resolved agent name (frontmatter `name` or filename-derived); undefined when the frontmatter does not parse. */
  name?: string
  problems: string[]
}

export interface AgentValidationReport {
  files: AgentFileReport[]
  /** Total problems across all files. */
  problems: number
}

/** Returns true/false when the provider's model list is known; undefined when it is not (offline/custom). */
export type KnownModelLookup = (providerID: string, modelID: string) => boolean | undefined

/** Builds a KnownModelLookup from the models.dev catalog and the configured providers. */
export function knownModelLookup(
  catalog: Record<string, { models?: Record<string, unknown> } | undefined>,
  providers: Record<string, { models?: Record<string, unknown> } | undefined> | undefined,
): KnownModelLookup {
  return (providerID, modelID) => {
    const configured = providers?.[providerID]?.models
    if (configured && modelID in configured) return true
    const listed = catalog[providerID]?.models
    if (listed && modelID in listed) return true
    // Flag only on positive knowledge of the provider's model list.
    if (configured || listed) return false
    return undefined
  }
}

/** Checks a `model` frontmatter value: inherit/Claude aliases pass, otherwise `provider/model` is required. */
export function modelProblem(model: string, knownModel: KnownModelLookup = () => undefined): string | undefined {
  const trimmed = model.trim()
  if (ConfigAgentV1.INHERIT_MODELS.has(trimmed.toLowerCase())) return undefined
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) {
    return `invalid model "${model}": expected "<provider>/<model>", "inherit", or a Claude alias (sonnet, opus, haiku)`
  }
  const providerID = trimmed.slice(0, slash)
  const modelID = trimmed.slice(slash + 1)
  if (knownModel(providerID, modelID) === false) return `unknown model "${providerID}/${modelID}"`
  return undefined
}

function toolEntries(tools: string | readonly unknown[]): string[] {
  return (typeof tools === "string" ? tools.split(",") : tools)
    .map((item) => (typeof item === "string" ? item.trim() : String(item)))
    .filter((item) => item.length > 0)
}

/** Flags `tools`/`disallowedTools` entries that map to a permission id YukiOshi does not know. */
export function toolProblems(field: "tools" | "disallowedTools", value: unknown): string[] {
  if (typeof value === "string" || Array.isArray(value)) {
    return toolEntries(value as string | string[])
      .map((entry) => ({ entry, permission: ConfigAgentV1.toolPermission(entry) }))
      .filter(({ permission }) => !ConfigAgentV1.KNOWN_PERMISSIONS.has(permission))
      .map(({ entry, permission }) => `${field} entry "${entry}" maps to unknown permission "${permission}"`)
  }
  // Record form (tools only): keys are tool/permission names; write/edit/patch all gate on `edit`.
  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => !ConfigAgentV1.KNOWN_PERMISSIONS.has(key === "write" || key === "patch" ? "edit" : key))
      .map((key) => `tools key "${key}" is not a known permission`)
  }
  return []
}

/** What validate knows about the runtime: skill names that exist, and whether background/parallel subagents are on. */
export interface RuntimeKnowledge {
  /** Returns "unknown" or "disabled" for a skill name that will be skipped, undefined for a usable one. */
  skillStatus?: (name: string, agentName: string) => "unknown" | "disabled" | undefined
  background?: boolean
  parallel?: boolean
}

/** Flags `skills`, `background` and `isolation` values that will be skipped or ignored at runtime. */
export function runtimeFieldProblems(name: string, data: Record<string, unknown>, runtime: RuntimeKnowledge): string[] {
  const problems: string[] = []
  if (Array.isArray(data.skills)) {
    const names = data.skills.filter((name): name is string => typeof name === "string")
    if (names.length > ConfigAgentV1.MAX_PRELOAD_SKILLS) {
      problems.push(
        `skills lists ${names.length} names; only the first ${ConfigAgentV1.MAX_PRELOAD_SKILLS} are preloaded`,
      )
    }
    for (const entry of names.slice(0, ConfigAgentV1.MAX_PRELOAD_SKILLS)) {
      const status = runtime.skillStatus?.(entry.trim(), name)
      if (status) problems.push(`skills entry "${entry}" is ${status} and will be skipped`)
    }
  }
  if (data.background === true && runtime.background === false) {
    problems.push(`background: true is ignored because "subagents": { "background": true } is not set in the config`)
  }
  if (data.isolation === "worktree" && runtime.parallel === false) {
    problems.push(`isolation: worktree is ignored because "subagents": { "parallel": true } is not set in the config`)
  }
  return problems
}

/** Flags frontmatter fields the agent schema does not know. */
export function unknownFieldProblems(data: Record<string, unknown>): string[] {
  return Object.keys(data)
    .filter((key) => !ConfigAgentV1.KNOWN_KEYS.has(key))
    .map((key) => `unknown frontmatter field "${key}"`)
}

export function permissionModeProblem(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().toLowerCase() === "bypasspermissions") {
    return `permissionMode "bypassPermissions" is not supported and is ignored`
  }
  return undefined
}

/** Runs the same schema decode as the config loader and turns failures into problem strings. */
export function schemaProblems(file: string, name: string, data: Record<string, unknown>, prompt: string): string[] {
  try {
    ConfigParse.schema(ConfigAgentV1.Info, { name, ...data, prompt }, file)
    return []
  } catch (error) {
    const issues =
      (error as { issues?: { message: string; path: string[] }[] }).issues ??
      (error as { data?: { issues?: { message: string; path: string[] }[] } }).data?.issues
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map(
        (issue) => `invalid frontmatter: ${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`,
      )
    }
    const detail = (error as { data?: { message?: string } }).data?.message
    return [`invalid frontmatter: ${detail ?? (error instanceof Error ? error.message : String(error))}`]
  }
}

/**
 * Scans the same agent markdown files as normal config discovery
 * (`{agent,agents}/**\/*.md` under each config directory) and reports per-file problems.
 * Directories must be in config-merge order: later directories win, which is also how
 * duplicate-name resolution below decides the winning file.
 */
export async function scanAgentFiles(
  directories: string[],
  opts: { knownModel?: KnownModelLookup; runtime?: RuntimeKnowledge } = {},
): Promise<AgentFileReport[]> {
  const reports: AgentFileReport[] = []
  for (const dir of directories) {
    const claude = isClaudeDir(dir)
    for (const file of await Glob.scan(claude ? "agents/**/*.md" : "{agent,agents}/**/*.md", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      const derived = configEntryNameFromPath(path.relative(dir, file), claude ? ["agents/"] : ["agent/", "agents/"])
      const md = await ConfigMarkdown.parse(file).catch((error: unknown) => error as Error)
      if (md instanceof Error) {
        const detail = (md as { data?: { message?: string } }).data?.message ?? md.message
        reports.push({ file, problems: [`failed to parse frontmatter: ${detail}`] })
        continue
      }
      const data = md.data as Record<string, unknown>
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : derived
      const problems = [
        ...unknownFieldProblems(data),
        ...toolProblems("tools", data.tools),
        ...toolProblems("disallowedTools", data.disallowedTools),
      ]
      const permissionMode = permissionModeProblem(data.permissionMode)
      if (permissionMode) problems.push(permissionMode)
      if (typeof data.model === "string") {
        const model = modelProblem(data.model, opts.knownModel)
        if (model) problems.push(model)
      }
      problems.push(...runtimeFieldProblems(name, data, opts.runtime ?? {}))
      problems.push(...schemaProblems(file, name, data, md.content.trim()))
      reports.push({ file, name, problems })
    }
  }
  return reports
}

/** Existing Claude agent directories to scan; empty unless the global config sets agent_sources: ["claude"]. */
export async function claudeAgentDirs(cfg: { agent_sources?: readonly string[] }, cwd = process.cwd()) {
  if (!cfg.agent_sources?.includes("claude")) return []
  const found: string[] = [path.join(Global.Path.home, ".claude")]
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ".claude")
    if (!found.includes(candidate)) found.push(candidate)
    if (path.dirname(dir) === dir) break
  }
  return found
}

/** Scans all agent files and additionally flags duplicate resolved names, naming the winning file. */
export async function validateAgentFiles(
  directories: string[],
  opts: { knownModel?: KnownModelLookup; runtime?: RuntimeKnowledge } = {},
): Promise<AgentValidationReport> {
  const files = await scanAgentFiles(directories, opts)
  const winners = new Map<string, string>()
  for (const report of files) {
    if (report.name) winners.set(report.name, report.file)
  }
  for (const report of files) {
    const winner = report.name ? winners.get(report.name) : undefined
    if (report.name && winner && winner !== report.file) {
      report.problems.push(`duplicate agent name "${report.name}"; ${winner} wins`)
    }
  }
  return { files, problems: files.reduce((total, report) => total + report.problems.length, 0) }
}

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: all). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
    if (!(args.path && args.description && args.mode && args.permissions !== undefined))
      yield* requireTerminal(
        "Creating an agent with prompts",
        'Pass every detail instead: `yukioshi agent create --path <dir> --description "<what it does>" --mode primary --permissions <list>` (see `yukioshi agent create --help`).',
      )
    yield* Effect.promise(async () => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliMode = args.mode as AgentMode | undefined
      const perms = args.permissions

      const isFullyNonInteractive = cliPath && cliDescription && cliMode && perms !== undefined

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro("Create agent")
      }

      const project = ctx.project

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = agentTargetDirectory({ path: cliPath })
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: "Location",
            options: [
              {
                label: "Current project",
                value: "project" as const,
                hint: ctx.worktree,
              },
              {
                label: "Global",
                value: "global" as const,
                hint: Global.Path.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = agentTargetDirectory({
          scope,
          worktree: ctx.worktree,
          globalConfig: Global.Path.config,
        })
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: "Description",
          placeholder: "What should this agent do?",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // Generate agent
      const spinner = prompts.spinner()
      spinner.start("Generating agent configuration...")
      const model = args.model ? Provider.parseModel(args.model) : undefined
      const generated = await runLocalEffect(agentSvc.generate({ description, model })).catch((error) => {
        spinner.stop(
          `Could not generate the agent: ${error.message}. Check that a provider is set up (\`yukioshi providers list\`, \`yukioshi providers login\`) or choose a model with --model provider/model.`,
          1,
        )
        if (isFullyNonInteractive) process.exit(1)
        throw new UI.CancelledError()
      })
      spinner.stop(`Agent ${generated.identifier} generated`)

      // Select permissions to allow
      let selected: string[]
      if (perms !== undefined) {
        selected = perms ? perms.split(",").map((t) => t.trim()) : AVAILABLE_PERMISSIONS
      } else {
        const result = await prompts.multiselect({
          message: "Select permissions to allow (Space to toggle)",
          options: AVAILABLE_PERMISSIONS.map((permission) => ({
            label: permission,
            value: permission,
          })),
          initialValues: AVAILABLE_PERMISSIONS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      // Get mode
      let mode: AgentMode
      if (cliMode) {
        mode = cliMode
      } else {
        const modeResult = await prompts.select({
          message: "Agent mode",
          options: [
            {
              label: "All",
              value: "all" as const,
              hint: "Can function in both primary and subagent roles",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "Acts as a primary/main agent",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "Can be used as a subagent by other agents",
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build permissions config — deny anything not explicitly selected.
      const permissions: Record<string, "deny"> = {}
      for (const permission of AVAILABLE_PERMISSIONS) {
        if (!selected.includes(permission)) {
          permissions[permission] = "deny"
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        permission?: Record<string, "deny">
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(permissions).length > 0) {
        frontmatter.permission = permissions
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      if (await Filesystem.exists(filePath)) {
        if (isFullyNonInteractive) {
          console.error(`Error: Agent file already exists: ${filePath}`)
          process.exit(1)
        }
        prompts.log.error(`Agent file already exists: ${filePath}`)
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(`Agent created: ${filePath}`)
        prompts.outro("Done")
      }
    })
  }),
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

const AgentValidateCommand = effectCmd({
  command: "validate",
  describe: "check agent markdown files for problems",
  builder: (yargs: Argv) =>
    yargs.option("format", {
      type: "string",
      describe: "output format",
      choices: ["table", "json"] as const,
      default: "table" as const,
    }),
  handler: Effect.fn("Cli.agent.validate")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { ModelsDev } = yield* Effect.promise(() => import("@yukioshi/core/models-dev"))
    const cfg = yield* Config.Service.use((svc) => svc.get())
    const dirs = withClaudeDirs(
      yield* Config.Service.use((svc) => svc.directories()),
      yield* Effect.promise(() => claudeAgentDirs(cfg)),
      Global.Path.config,
    )
    const catalog = yield* ModelsDev.Service.use((svc) => svc.get()).pipe(
      Effect.catch(() => Effect.succeed({} as Record<string, { models?: Record<string, unknown> }>)),
    )
    const { Skill } = yield* Effect.promise(() => import("@/skill"))
    const { Permission } = yield* Effect.promise(() => import("@/permission"))
    const { backgroundSubagents, parallelSubagents } = yield* Effect.promise(() => import("../../tool/subagents"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const flags = yield* RuntimeFlags.Service
    const skills = yield* Skill.Service.use((svc) => svc.all())
    const known = new Set(skills.map((item) => item.name))
    const agents = yield* Effect.promise(() => import("../../agent/agent")).pipe(
      Effect.flatMap(({ Agent }) => Agent.Service.use((svc) => svc.list())),
    )
    const report = yield* Effect.promise(() =>
      validateAgentFiles(dirs, {
        knownModel: knownModelLookup(catalog, cfg.provider),
        runtime: {
          skillStatus: (name, agentName) => {
            if (!known.has(name)) return "unknown"
            const agent = agents.find((item) => item.name === agentName)
            return agent && Permission.evaluate("skill", name, agent.permission).action === "deny"
              ? "disabled"
              : undefined
          },
          background: backgroundSubagents(flags, cfg),
          parallel: parallelSubagents(flags, cfg),
        },
      }),
    )

    if (args.format === "json") {
      process.stdout.write(
        JSON.stringify({ ok: report.problems === 0, files: report.files, problems: report.problems }, null, 2) + EOL,
      )
    } else {
      for (const file of report.files) {
        const label = file.name ? `${file.file} (${file.name})` : file.file
        if (file.problems.length === 0) {
          process.stdout.write(`${label}: ok` + EOL)
          continue
        }
        process.stdout.write(label + EOL)
        for (const problem of file.problems) process.stdout.write(`  - ${problem}` + EOL)
      }
      process.stdout.write(
        report.problems === 0
          ? `All ${report.files.length} agent file(s) are valid` + EOL
          : `${report.problems} problem(s) in ${report.files.length} agent file(s)` + EOL,
      )
    }
    if (report.problems > 0) return yield* fail(`agent validation found ${report.problems} problem(s)`)
  }),
})

const AgentShowCommand = effectCmd({
  command: "show <name>",
  describe: "print the resolved configuration of an agent as JSON",
  builder: (yargs: Argv) =>
    yargs.positional("name", {
      type: "string",
      demandOption: true,
      describe: "agent name",
    }),
  handler: Effect.fn("Cli.agent.show")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const agent: import("../../agent/agent").Info | undefined = yield* Agent.Service.use((svc) => svc.get(args.name))
    if (!agent) return yield* fail(`Unknown agent "${args.name}" (see \`yukioshi agent list\`)`)

    // Locate the markdown file this agent came from, if any. The same scan order as
    // config loading applies, so the last file with the resolved name is the winner.
    const cfg = yield* Config.Service.use((svc) => svc.get())
    const dirs = withClaudeDirs(
      yield* Config.Service.use((svc) => svc.directories()),
      yield* Effect.promise(() => claudeAgentDirs(cfg)),
      Global.Path.config,
    )
    const files = yield* Effect.promise(() => scanAgentFiles(dirs))
    const source = files.findLast((file) => file.name === agent.name)?.file ?? null

    process.stdout.write(
      JSON.stringify(
        {
          name: agent.name,
          source,
          description: agent.description ?? null,
          mode: agent.mode,
          model: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : null,
          steps: agent.steps ?? null,
          variant: agent.variant ?? null,
          skills: agent.skills ?? [],
          background: agent.background ?? false,
          isolation: agent.isolation ?? null,
          initialPrompt: agent.initialPrompt ?? null,
          permission: agent.permission,
        },
        null,
        2,
      ) + EOL,
    )
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) =>
    yargs
      .command(AgentCreateCommand)
      .command(AgentListCommand)
      .command(AgentValidateCommand)
      .command(AgentShowCommand)
      .demandCommand(),
  async handler() {},
})
