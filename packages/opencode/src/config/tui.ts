export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep } from "remeda"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Cause, Context, Effect, Fiber, Layer } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@yukioshi/core/flag/flag"
import { isRecord } from "@yukioshi/tui/util/record"
import { Global } from "@yukioshi/core/global"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CurrentWorkingDirectory } from "./tui-cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "@yukioshi/tui/config/keybind"
import { InstallationLocal, InstallationVersion } from "@yukioshi/core/installation/version"
import { makeRuntime } from "@yukioshi/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@yukioshi/core/npm"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@yukioshi/tui/config"
import { ProjectTrust } from "@/project/trust"

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = TuiConfig.Resolved

export type HostMetadata = {
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly pluginOrigins: () => Effect.Effect<ConfigPlugin.Origin[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/TuiConfig") {}

function pluginScope(file: string, projectRoot: string): ConfigPlugin.Scope {
  if (Filesystem.contains(projectRoot, file)) return "local"
  return "global"
}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  let appliedOrder = 0
  const trustRoot = yield* Effect.promise(() => ProjectTrust.resolveRoot(ctx.directory))
  const projectTrusted = yield* Effect.tryPromise(() => ProjectTrust.isTrusted(trustRoot)).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to read project trust; project TUI plugins remain disabled", {
        project: trustRoot,
        error,
      }).pipe(Effect.as(false)),
    ),
  )
  const blockedPlugins = new Set<string>()

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      return {
        ...config,
        plugin: yield* Effect.forEach(plugins, (plugin) =>
          Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugin, configFilepath)),
        ),
      }
    })

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old opencode.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data))
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid tui config", {
          path: configFilepath,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read tui config", {
            path: filepath,
            reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!text) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const mergeFile = (acc: Acc, file: string, options?: { project?: boolean; scope?: ConfigPlugin.Scope }) =>
    Effect.gen(function* () {
      let data = yield* loadFile(file)
      if (options?.project && !projectTrusted && data.plugin?.length) {
        blockedPlugins.add(file)
        const { plugin: _plugin, ...safe } = data
        data = safe as Info
      }
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = options?.scope ?? pluginScope(file, trustRoot)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec, scope, source: file })),
      ])
      acc.result = {
        ...acc.result,
        plugin: plugins.map((item) => item.spec),
      }
      acc.plugin_origins = plugins
    })

  // Every config dir we may read from: global config dir, any `.yukioshi` / `.opencode`
  // folders between cwd and home, and YUKIOSHI_CONFIG_DIR.
  const directoryEntries = yield* ConfigPaths.directoryEntries(ctx.directory)
  const directories = directoryEntries.map((entry) => entry.path)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.YUKIOSHI_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file, { scope: "global" })
  }

  // 2. Explicit YUKIOSHI_TUI_CONFIG override, if set.
  if (Flag.YUKIOSHI_TUI_CONFIG) {
    const configFile = Flag.YUKIOSHI_TUI_CONFIG
    yield* mergeFile(acc, configFile, {
      project: FSUtil.contains(trustRoot, ProjectTrust.canonical(configFile)),
    })
    yield* Effect.logDebug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file, { project: true, scope: "local" })
  }

  // 4. `.yukioshi` / `.opencode` directories (and YUKIOSHI_CONFIG_DIR) discovered while
  // walking up the tree. Also returned below so callers can install plugin
  // dependencies from each location.
  const dirs = directoryEntries.filter(
    (entry) =>
      entry.path.endsWith(".opencode") || entry.path.endsWith(".yukioshi") || entry.path === Flag.YUKIOSHI_CONFIG_DIR,
  )

  for (const entry of dirs) {
    const dir = entry.path
    const isProject =
      entry.scope === "project" ||
      (entry.scope === "explicit" && FSUtil.contains(trustRoot, ProjectTrust.canonical(dir)))
    if (!dir.endsWith(".opencode") && !dir.endsWith(".yukioshi") && dir !== Flag.YUKIOSHI_CONFIG_DIR) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file, {
        project: isProject,
        scope: entry.scope === "global" ? "global" : entry.scope === "project" ? "local" : undefined,
      })
    }
  }

  if (blockedPlugins.size > 0) {
    yield* Effect.logWarning("project TUI plugins are disabled until this project is explicitly trusted", {
      project: trustRoot,
      blocked: Array.from(blockedPlugins),
      command: `yukioshi trust ${JSON.stringify(trustRoot)}`,
    })
  }

  const result = TuiConfig.resolve(
    {
      ...acc.result,
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )

  return {
    config: result,
    pluginOrigins: acc.plugin_origins,
    dirs: result.plugin?.length
      ? dirs
          .filter(
            (entry) =>
              projectTrusted ||
              (entry.scope !== "project" &&
                !(entry.scope === "explicit" && FSUtil.contains(trustRoot, ProjectTrust.canonical(entry.path)))),
          )
          .map((entry) => entry.path)
      : [],
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    const deps = yield* Effect.forEach(
      data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@yukioshi/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const pluginOrigins = Effect.fn("TuiConfig.pluginOrigins")(() => Effect.succeed(data.pluginOrigins))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, pluginOrigins, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Npm.node, FSUtil.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}

export async function pluginOrigins() {
  return runPromise((svc) => svc.pluginOrigins())
}
