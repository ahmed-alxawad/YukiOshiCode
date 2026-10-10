import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"

import { ConfigPaths } from "@/config/paths"
import { Global } from "@yukioshi/core/global"
import { installPlugin, patchPluginConfig, readPluginManifest } from "../../plugin/install"
import { resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "yukioshi" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name).toReversed(),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx) => {
    const install = dep.spinner()
    install.start("Installing plugin package...")
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop("Install failed", 1)
      dep.log.error(`Could not install "${mod}"`)
      const hit = cause(target.error) ?? target.error
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) dep.log.error(detail)
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info("This package depends on a version that is not available in your npm registry.")
          dep.log.info("Check npm registry/auth settings and try again.")
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        dep.log.error(errorMessage(hit))
      }
      return false
    }
    install.stop("Plugin package ready")

    const inspect = dep.spinner()
    inspect.start("Reading plugin manifest...")
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop("Manifest read failed", 1)
        dep.log.error(`Installed "${mod}" but failed to read ${manifest.file}`)
        dep.log.error(errorMessage(cause(manifest.error) ?? manifest.error))
        return false
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop("No plugin targets found", 1)
        dep.log.error(`"${mod}" does not expose plugin entrypoints in package.json`)
        dep.log.info(
          'Expected one of: exports["./tui"], exports["./server"], package.json main for server, or package.json["oc-themes"] for tui themes.',
        )
        return false
      }

      inspect.stop("Manifest read failed", 1)
      return false
    }

    inspect.stop(
      `Detected ${manifest.targets.map((item) => item.kind).join(" + ")} target${manifest.targets.length === 1 ? "" : "s"}`,
    )

    const patch = dep.spinner()
    patch.start("Updating plugin config...")
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(`Failed updating ${out.kind} config`, 1)
        dep.log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        dep.log.info("Fix the config file and run the command again.")
        return false
      }

      patch.stop("Failed updating plugin config", 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop("Plugin config updated")
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(`Already configured in ${item.file}`)
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(`Replaced in ${item.file}`)
        continue
      }
      dep.log.info(`Added to ${item.file}`)
    }

    dep.log.success(`Installed ${mod}`)
    dep.log.info(global ? `Scope: global (${out.dir})` : `Scope: local (${out.dir})`)
    return true
  }
}

import { ClaudePlugin } from "../../plugin/claude"
import { CliError, fail } from "../effect-cmd"

function userFacing<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
  })
}

/** Words people type as a plugin action that would otherwise be installed from npm as a package of that name. */
export const NOT_PACKAGE_NAMES = new Set([
  "install",
  "uninstall",
  "delete",
  "update",
  "upgrade",
  "ls",
  "search",
  "info",
  "enable",
  "disable",
  "init",
  "new",
  "create",
])

export type PlugCmdArgs = {
  action?: string
  target?: string
  extra?: string
  name?: string
  module?: string
  global?: boolean
  force?: boolean
}

import type { Argv } from "yargs"

export const PluginCommand = effectCmd({
  command: "plugin [action] [target] [extra]",
  aliases: ["plug"],
  describe: "install, list, or remove plugins (npm packages, or Claude Code plugins/marketplaces from git)",
  instance: (args: PlugCmdArgs) => {
    const act = String(args.action ?? "")
      .toLowerCase()
      .trim()
    return !["add", "list", "remove", "rm"].includes(act)
  },
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        type: "string",
        describe: "subcommand (add, list, remove) or npm module name",
      })
      .positional("target", {
        type: "string",
        describe: "git URL or marketplace repository (for add), or plugin name (for remove)",
      })
      .positional("extra", {
        type: "string",
        describe: "plugin name within marketplace (for add)",
      })
      .option("name", {
        type: "string",
        describe: "folder name to install under (add); defaults to the plugin name",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "install in global config",
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: "replace existing plugin version",
      }),
  handler: Effect.fn("Cli.plug")(function* (args: PlugCmdArgs) {
    const rawAction = String(args.action ?? "").trim()
    const action = rawAction.toLowerCase()

    if (action === "list") {
      const items = yield* userFacing(() => ClaudePlugin.list())
      if (!items.length) {
        UI.println("No plugins installed from git. Add one with: yukioshi plugin add <git-url>")
        return
      }
      for (const item of items) {
        UI.println(`${item.name}  ${item.url}`)
        if (item.commands.length) UI.println(`  commands: ${item.commands.join(", ")}`)
        if (item.agents.length) UI.println(`  agents: ${item.agents.join(", ")}`)
        if (item.skills.length) UI.println(`  skills: ${item.skills.join(", ")}`)
      }
      return
    }

    if (action === "add") {
      if (!args.target)
        return yield* fail(
          "plugin add needs a git URL or marketplace repository. Example: `yukioshi plugin add https://github.com/owner/repo`.",
        )
      const result = yield* userFacing(() =>
        ClaudePlugin.add({ url: args.target!, plugin: args.extra, name: args.name }),
      )
      if (result.type === "marketplace") {
        UI.println(`Marketplace: ${result.name} (${result.url})`)
        if (result.description) UI.println(result.description)
        UI.empty()
        UI.println("Available plugins:")
        for (const p of result.plugins) {
          UI.println(`  ${p.name}${p.description ? `: ${p.description}` : ""}`)
        }
        UI.empty()
        UI.println(`To install a plugin: yukioshi plugin add ${result.url} <plugin-name>`)
        return
      }

      const p = result.plugin
      UI.println(`Installed plugin ${p.name} from ${p.url}`)
      if (p.commands.length) UI.println(`  Commands: ${p.commands.join(", ")}`)
      if (p.agents.length) UI.println(`  Agents: ${p.agents.join(", ")}`)
      if (p.skills.length) UI.println(`  Skills: ${p.skills.join(", ")}`)
      for (const [agent, fields] of Object.entries(p.droppedFields)) {
        if (fields.length) UI.println(`  Agent ${agent}: dropped unknown fields (${fields.join(", ")})`)
      }
      if (p.skippedHooks.length) {
        UI.println(`  Hooks (not installed: runs programs):`)
        for (const h of p.skippedHooks) {
          UI.println(`    ${h.event ?? "hook"}: ${h.command}`)
        }
      }
      if (p.skippedMcp.length) {
        UI.println(`  MCP servers (not installed: runs programs):`)
        for (const m of p.skippedMcp) {
          UI.println(`    ${m.name ?? "server"}: ${m.command}`)
        }
      }
      UI.println("Only skills, commands, and agents were installed; no programs or hooks were enabled.")
      return
    }

    if (action === "remove" || action === "rm") {
      if (!args.target)
        return yield* fail(
          "plugin remove needs a plugin name. Run `yukioshi plugin list` to see what is installed, then `yukioshi plugin remove <name>`.",
        )
      yield* userFacing(() => ClaudePlugin.remove(args.target!))
      UI.println(`Removed ${args.target}`)
      return
    }

    // Default: treat as npm module name (existing yukioshi plugin <module> behavior)
    const mod = rawAction || String(args.module ?? "").trim()
    if (NOT_PACKAGE_NAMES.has(mod.toLowerCase()))
      return yield* fail(
        `"${mod}" is not a plugin package. Use \`yukioshi plugin add <git-url>\` to install from git, \`yukioshi plugin list\` to see what is installed, \`yukioshi plugin remove <name>\` to remove one, or \`yukioshi plugin <npm-package>\` for an npm package.`,
      )
    if (!mod) {
      UI.error(
        "Say what to do: `yukioshi plugin list`, `yukioshi plugin add <git-url>`, `yukioshi plugin remove <name>`, or `yukioshi plugin <npm-package>` to install a plugin from npm.",
      )
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Install plugin ${mod}`)

    const run = createPlugTask({
      mod,
      global: Boolean(args.global),
      force: Boolean(args.force),
    })

    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    outro("Done")
    if (!ok) process.exitCode = 1
  }),
})
