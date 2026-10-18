export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@yukioshi/core/util/glob"
import { ConfigAgentV1 } from "@yukioshi/core/v1/config/agent"
import type { DeepMutable } from "@yukioshi/core/schema"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

// Claude model aliases carry no provider/model id, so the schema drops them and the agent
// inherits the parent model; warn here, where the agent file path is known. The same goes
// for permissionMode "bypassPermissions", which is never honored. Files without these
// keys stay silent.
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku"])
function warnIgnored(agentFile: string, data: Record<string, unknown>) {
  if (typeof data.model === "string" && MODEL_ALIASES.has(data.model.trim().toLowerCase())) {
    console.warn(
      `[config] ${agentFile}: model "${data.model}" is a Claude alias; the agent inherits the parent model instead`,
    )
  }
  if (typeof data.permissionMode === "string" && data.permissionMode.trim().toLowerCase() === "bypasspermissions") {
    console.warn(`[config] ${agentFile}: permissionMode "bypassPermissions" is not supported and was ignored`)
  }
}

// Claude-style agent directory (`~/.claude`, `<project>/.claude`): only `agents/` is read.
export async function loadClaude(dir: string) {
  return load(dir, "agents/**/*.md", ["agents/"])
}

// Session-only agents from `yukioshi run --agents`: the same field handling as markdown
// agents, with `prompt` as the system prompt. Throws a readable error on a bad entry.
export function fromRecord(input: Record<string, unknown>, source = "--agents") {
  const result: Record<string, DeepMutable<ConfigAgentV1.Info>> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`${source}: agent "${name}" must be an object`)
    const data = value as Record<string, unknown>
    if (typeof data.prompt !== "string" || !data.prompt.trim())
      throw new Error(`${source}: agent "${name}" needs a non-empty "prompt" (the system prompt)`)
    warnIgnored(`${source} ${name}`, data)
    result[name] = ConfigParse.schema(ConfigAgentV1.Info, { name, ...data, prompt: data.prompt.trim() }, `${source}:${name}`)
  }
  return result
}

export async function load(dir: string, pattern = "{agent,agents}/**/*.md", prefixes = ["agent/", "agents/"]) {
  const result: Record<string, DeepMutable<ConfigAgentV1.Info>> = {}
  for (const item of await Glob.scan(pattern, {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), prefixes)

    warnIgnored(item, md.data)
    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, DeepMutable<ConfigAgentV1.Info>> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    warnIgnored(item, md.data)
    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...(parsed.value as DeepMutable<ConfigAgentV1.Info>),
        mode: "primary" as const,
      }
    }
  }
  return result
}
