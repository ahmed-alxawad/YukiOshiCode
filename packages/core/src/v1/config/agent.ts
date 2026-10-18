export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"
import { ConfigHooksV1 } from "./hooks"
import { ConfigMCPV1 } from "./mcp"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export const AgentHooks = Schema.Struct({
  preToolUse: ConfigHooksV1.Info.fields.preToolUse,
  postToolUse: ConfigHooksV1.Info.fields.postToolUse,
  stop: ConfigHooksV1.Info.fields.stop,
}).annotate({ identifier: "AgentHooksConfig" })

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(
      Schema.Union([Schema.Record(Schema.String, Schema.Boolean), Schema.String, Schema.Array(Schema.String)]),
    ).annotate({
      description:
        "@deprecated Use 'permission' field instead. A record maps tool names to on/off; a comma-separated string or string list is an allowlist of Claude/Qwen-style tool names.",
    }),
    disallowedTools: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
      description: "Claude-style list of tools to deny, applied after 'tools' and 'permission' (last match wins)",
    }),
    maxTurns: Schema.optional(PositiveInt).annotate({
      description: "Claude-style alias for 'steps'; ignored when 'steps' is set",
    }),
    permissionMode: Schema.optional(Schema.String).annotate({
      description:
        "Claude-style permission mode: 'default', 'acceptEdits', or 'plan'. 'bypassPermissions' is never honored.",
    }),
    skills: Schema.optional(Schema.Array(Schema.String)).annotate({
      description:
        "Names of enabled skills whose content is added to this agent's system prompt (at most 32; unknown or disabled names are skipped)",
    }),
    background: Schema.optional(Schema.Boolean).annotate({
      description: "Start this agent in the background when the task tool uses it (needs subagents.background)",
    }),
    fork: Schema.optional(Schema.Boolean).annotate({
      description: "Start this agent with a copy of the parent conversation when the task tool uses it (needs subagents.fork)",
    }),
    isolation: Schema.optional(Schema.Literal("worktree")).annotate({
      description: "Run this agent in its own git worktree when the task tool uses it (needs subagents.parallel)",
    }),
    effort: Schema.optional(Schema.String).annotate({
      description: "Claude-style alias for 'variant'; ignored when 'variant' is set",
    }),
    initialPrompt: Schema.optional(Schema.String).annotate({
      description: "Text added before the first user message of this agent when it runs as a subagent",
    }),
    hooks: Schema.optional(AgentHooks).annotate({
      description:
        "Hooks (preToolUse, postToolUse, stop) that run only in this agent's sessions, after the global hooks. Honored only for agents from trusted sources.",
    }),
    mcpServers: Schema.optional(
      Schema.Record(Schema.String, Schema.Union([Schema.String, ConfigMCPV1.Info])),
    ).annotate({
      description:
        "MCP servers for this agent: a name of an already configured server, or an inline server definition started for this agent's session only. Inline servers are honored only for agents from trusted sources.",
    }),
    memory: Schema.optional(Schema.Literals(["user", "project"])).annotate({
      description:
        "Give this agent its own memory file: 'user' (your data directory) or 'project' (.yukioshi/agent-memory, trusted projects only)",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

// Frontmatter keys the agent schema understands; everything else is collected into
// `options` by the decode below. Exported so `yukioshi agent validate` can flag unknown
// keys against the same list instead of drifting from it.
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "maxTurns",
  "options",
  "permission",
  "disable",
  "tools",
  "disallowedTools",
  "permissionMode",
  "skills",
  "background",
  "fork",
  "isolation",
  "effort",
  "initialPrompt",
  "hooks",
  "mcpServers",
  "memory",
])

// Most skills one agent can preload into its system prompt.
export const MAX_PRELOAD_SKILLS = 32

// Permission ids YukiOshi knows: the typed keys of ConfigPermissionV1 plus the
// runtime-only ids the permissionMode mapping below can emit. Not exhaustive — MCP
// tools and custom permission keys resolve to other ids — so use this for linting,
// not for rejecting config.
export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set([
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
  "delegate",
  "memory_save",
  "skill_save",
])

// Claude/Qwen tool names mapped to YukiOshi permission ids. Lookup is
// case-insensitive; unknown names pass through lowercased so they stay
// representable as permission keys.
const TOOL_PERMISSION: Record<string, string> = {
  read: "read",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  patch: "edit",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  webfetch: "webfetch",
  websearch: "websearch",
  task: "task",
  todowrite: "todowrite",
  read_file: "read",
  read_many_files: "read",
  write_file: "edit",
  run_shell_command: "bash",
  grep_search: "grep",
  web_fetch: "webfetch",
  web_search: "websearch",
  todo_write: "todowrite",
}

export const toolPermission = (name: string): string => {
  const lowered = name.trim().toLowerCase()
  const known = TOOL_PERMISSION[lowered]
  if (known) return known
  if (lowered.startsWith("mcp__")) {
    // Claude writes MCP tools as mcp__<server>__<tool>; YukiOshi permission ids join the
    // sanitized server and tool name with a single underscore (see McpCatalog.toolName).
    return lowered
      .slice("mcp__".length)
      .split("__")
      .filter((part) => part.length > 0)
      .join("_")
      .replace(/[^a-z0-9_*-]/g, "_")
  }
  return lowered
}

const toolList = (tools: string | readonly string[]): string[] =>
  (typeof tools === "string" ? tools.split(",") : tools).map((item) => item.trim()).filter((item) => item.length > 0)

// Model values that mean "no own model": the runtime inherits the parent model.
export const INHERIT_MODELS: ReadonlySet<string> = new Set(["inherit", "sonnet", "opus", "haiku"])

// Plan mode keeps read-only capabilities (read/grep/glob/list/websearch/question and
// other low-risk lookups) usable and denies everything that changes files, runs
// commands, or reaches outside the project.
const PLAN_DENY = [
  "edit",
  "bash",
  "webfetch",
  "task",
  "delegate",
  "external_directory",
  "todowrite",
  "memory_save",
  "skill_save",
  "lsp",
  "skill",
]

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermissionV1.Info = {}
  if (Array.isArray(agent.tools) || typeof agent.tools === "string") {
    // String/list form is an allowlist: explicit permissions come first, then deny
    // everything, then allow only the listed tools.
    globalThis.Object.assign(permission, agent.permission)
    permission["*"] = "deny"
    for (const name of toolList(agent.tools)) {
      permission[toolPermission(name)] = "allow"
    }
  } else {
    for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
      const action = enabled ? "allow" : "deny"
      if (tool === "write" || tool === "edit" || tool === "patch") {
        permission.edit = action
        continue
      }
      permission[tool] = action
    }
    globalThis.Object.assign(permission, agent.permission)
  }

  // Rules are last-match-wins, so later assignments here are stronger: permissionMode
  // overrides explicit permissions, and disallowedTools overrides everything.
  const permissionMode = agent.permissionMode?.trim().toLowerCase()
  if (permissionMode === "acceptedits") permission.edit = "allow"
  if (permissionMode === "plan") {
    for (const key of PLAN_DENY) permission[key] = "deny"
  }
  for (const name of toolList(agent.disallowedTools ?? [])) {
    permission[toolPermission(name)] = "deny"
  }

  const steps = agent.steps ?? agent.maxTurns ?? agent.maxSteps
  const result = { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }
  if (agent.model !== undefined && INHERIT_MODELS.has(agent.model.trim().toLowerCase())) delete result.model
  return result
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
