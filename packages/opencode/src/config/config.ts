import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { serviceUse } from "@yukioshi/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@yukioshi/core/global"
import fsNode from "fs/promises"
import { Flag } from "@yukioshi/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@yukioshi/core/v1/config/console-state"
import { FSUtil } from "@yukioshi/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@yukioshi/core/v1/config/config"
import { RemoteAuthError } from "@yukioshi/core/v1/config/error"
import { ConfigPermissionV1 } from "@yukioshi/core/v1/config/permission"
import { ConfigPluginV1 } from "@yukioshi/core/v1/config/plugin"
import { ConfigMCPV1 } from "@yukioshi/core/v1/config/mcp"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { Npm } from "@yukioshi/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ProjectTrust } from "@/project/trust"
import { ModelsDev } from "@yukioshi/core/models-dev"

declare const YUKIOSHI_MODELS_DEV: Record<string, unknown> | undefined

const BUILTIN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "openrouter",
  "deepseek",
  "cohere",
  "bedrock",
  "azure",
  "github-copilot",
  "vertex",
  "amazon-bedrock",
  "cloudflare-ai-gateway",
  "xai",
  "together",
  "fireworks",
  "cerebras",
  "perplexity",
])

function isDangerousOption(key: string): boolean {
  if (key === "headerTimeout" || key === "timeout" || key === "chunkTimeout" || key === "setCacheKey") {
    return false
  }
  const lower = key.toLowerCase()
  if (
    lower === "baseurl" ||
    lower === "base_url" ||
    lower === "url" ||
    lower === "endpoint" ||
    lower === "headers" ||
    lower === "header" ||
    lower === "apikey" ||
    lower === "apikeys" ||
    lower === "api_key" ||
    lower === "api_keys" ||
    lower === "fetch" ||
    lower === "customfetch" ||
    lower === "custom_fetch" ||
    lower === "enterpriseurl" ||
    lower === "enterprise_url" ||
    lower === "client" ||
    lower === "httpclient"
  ) {
    return true
  }
  if (lower.includes("url") || lower.includes("endpoint") || lower.includes("header") || lower.includes("fetch")) {
    return true
  }
  if (
    lower.includes("apikey") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("credential") ||
    lower.includes("auth") ||
    lower.includes("password")
  ) {
    return true
  }
  return false
}

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  // Project-declared skill sources keep provenance after config merging so the skill loader can place
  // them in the project namespace instead of allowing them to shadow built-ins.
  project_skill_paths?: string[]
  project_skill_urls?: string[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Config") {}

export const use = serviceUse(Service)

const CONFIG_NAMES = ["opencode", "yukioshi"] as const
const CONFIG_FILES = CONFIG_NAMES.flatMap((name) => [`${name}.json`, `${name}.jsonc`])

function globalConfigFile() {
  const candidates = ["yukioshi.jsonc", "yukioshi.json", "opencode.jsonc", "opencode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const {
    plugin_origins: _plugin_origins,
    project_skill_paths: _project_skill_paths,
    project_skill_urls: _project_skill_urls,
    ...next
  } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const decodeConfig = Effect.fnUntraced(function* (input: unknown, source: string) {
      const result = ConfigV2Compat.lower(normalizeLoadedConfig(input), source)
      yield* Effect.forEach(result.diagnostics, (diagnostic) =>
        Effect.logWarning("configuration compatibility diagnostic", {
          source,
          path: diagnostic.path,
          kind: diagnostic.kind,
          action: diagnostic.message,
        }),
      )
      return ConfigParse.schema(ConfigV1.Info, result.value, source)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = yield* decodeConfig(parsed, source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config file, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.YUKIOSHI_CONFIG && !Flag.YUKIOSHI_CONFIG_DIR && !Flag.YUKIOSHI_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({}, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      for (const file of CONFIG_FILES) {
        result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, file), env))
      }

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined
        const projectSkillPaths = new Set<string>()
        const projectSkillUrls = new Set<string>()
        const trustRoot = ProjectTrust.root(ctx)
        const projectTrusted = yield* Effect.tryPromise(() => ProjectTrust.isTrusted(trustRoot)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to read project trust; executable project config remains disabled", {
              project: trustRoot,
              error,
            }).pipe(Effect.as(false)),
          ),
        )
        const blockedExecutables = new Set<string>()

        const modelsDevSvc = yield* Effect.serviceOption(ModelsDev.Service)
        let modelsDevCatalog: Record<string, unknown> | undefined
        if (Option.isSome(modelsDevSvc)) {
          modelsDevCatalog = yield* modelsDevSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
        }
        if (!modelsDevCatalog) {
          if (typeof YUKIOSHI_MODELS_DEV !== "undefined") {
            modelsDevCatalog = YUKIOSHI_MODELS_DEV
          } else {
            const modelsPath = Flag.YUKIOSHI_MODELS_PATH ?? path.join(Global.Path.cache, "models.json")
            modelsDevCatalog = yield* fs
              .readJson(modelsPath)
              .pipe(
                Effect.map((data) => (isRecord(data) ? (data as Record<string, unknown>) : undefined)),
                Effect.catch(() => Effect.succeed(undefined)),
              )
          }
        }

        // A command template can run shell commands (!`cmd`) when the command is used, with no permission
        // prompt, and a project can name its command like a built-in one (/init, /review). So an untrusted
        // project's commands that contain one are dropped until the project is trusted.
        const withoutShellCommands = <T extends { template: string }>(label: string, commands: Record<string, T>) =>
          Object.fromEntries(
            Object.entries(commands).filter(([name, command]) => {
              if (!/!`[^`]+`/.test(command.template)) return true
              blockedExecutables.add(`${label} (command ${name} runs shell commands)`)
              return false
            }),
          )

        const projectConfig = (source: string, next: Info) => {
          if (next.triggers) {
            blockedExecutables.add(`${source} (triggers)`)
            delete next.triggers
          }
          if (next.audit) {
            delete next.audit
          }
          for (const item of next.skills?.paths ?? []) projectSkillPaths.add(item)
          if (projectTrusted) {
            for (const item of next.skills?.urls ?? []) projectSkillUrls.add(item)
            return next
          }
          // Delegate agents run a command, webhooks send session events to a URL, enterprise/share
          // exfiltrates sessions, and remote skills/instructions/MCP headers fetch third-party code
          // or leak credentials, so like hooks they are ignored until the project is trusted.
          const { hooks, plugin, delegate, webhooks, enterprise, browser, triggers, audit, ...safe } = next
          if (plugin?.length) blockedExecutables.add(`${source} (plugins)`)
          if (delegate?.agents && Object.keys(delegate.agents).length > 0)
            blockedExecutables.add(`${source} (delegate agents)`)
          if (webhooks?.length) blockedExecutables.add(`${source} (webhooks)`)
          if (hooks && Object.values(hooks).some((entries) => entries.length > 0)) {
            blockedExecutables.add(`${source} (hooks)`)
          }
          if (enterprise?.url) blockedExecutables.add(`${source} (enterprise)`)
          if (browser?.enabled) blockedExecutables.add(`${source} (browser)`)
          if (safe.share === "auto") {
            blockedExecutables.add(`${source} (auto-share)`)
            safe.share = undefined
          }
          if (safe.skills?.urls?.length) {
            blockedExecutables.add(`${source} (remote skills)`)
            safe.skills = { ...safe.skills, urls: undefined }
          }
          if (safe.instructions?.length) {
            const remoteInstructions = safe.instructions.filter(
              (item) => item.startsWith("http://") || item.startsWith("https://"),
            )
            if (remoteInstructions.length > 0) {
              blockedExecutables.add(`${source} (remote instructions)`)
              safe.instructions = safe.instructions.filter(
                (item) => !item.startsWith("http://") && !item.startsWith("https://"),
              )
            }
          }
          // Local MCP servers and custom LSP/formatter commands run programs too, so an
          // untrusted project may only reference remote servers without credentials and disable built-ins.
          const runsCommand = (entry: unknown) => isRecord(entry) && Array.isArray(entry["command"])
          const withoutCommands = <T,>(label: string, entries: Record<string, T>) =>
            Object.fromEntries(
              Object.entries(entries).flatMap(([name, entry]) => {
                if (runsCommand(entry)) {
                  blockedExecutables.add(`${source} (${label} ${name})`)
                  return []
                }
                if (
                  label === "MCP server" &&
                  isRecord(entry) &&
                  isRecord(entry["headers"]) &&
                  Object.keys(entry["headers"]).length > 0
                ) {
                  blockedExecutables.add(`${source} (${label} ${name} headers)`)
                  return [[name, { ...(entry as any), headers: undefined } as T]]
                }
                return [[name, entry]]
              }),
            )
          if (safe.command) safe.command = withoutShellCommands(source, safe.command)
          if (safe.mcp) safe.mcp = withoutCommands("MCP server", safe.mcp)
          if (isRecord(safe.lsp)) safe.lsp = withoutCommands("LSP server", safe.lsp) as typeof safe.lsp
          if (isRecord(safe.formatter)) safe.formatter = withoutCommands("formatter", safe.formatter) as typeof safe.formatter

          if (source !== "YUKIOSHI_CONFIG_CONTENT") {
            const sanitizeProviders = (providersRecord: Record<string, any> | undefined) => {
              if (!providersRecord || !isRecord(providersRecord)) return providersRecord
              const sanitized: Record<string, any> = {}
              for (const [id, providerEntry] of Object.entries(providersRecord)) {
                if (!isRecord(providerEntry)) {
                  sanitized[id] = providerEntry
                  continue
                }
                const isKnown =
                  BUILTIN_PROVIDERS.has(id) ||
                  (modelsDevCatalog !== undefined && id in modelsDevCatalog) ||
                  (result.provider !== undefined && id in result.provider) ||
                  ((result as any).providers !== undefined && id in (result as any).providers) ||
                  id in auth ||
                  consoleManagedProviders.has(id)

                if (!isKnown) {
                  blockedExecutables.add(`${source} (provider ${id})`)
                  continue
                }

                const entryCopy = { ...providerEntry }
                if (entryCopy.api !== undefined) {
                  blockedExecutables.add(`${source} (provider ${id} api)`)
                  delete entryCopy.api
                }
                if ((entryCopy as any).baseURL !== undefined) {
                  blockedExecutables.add(`${source} (provider ${id} baseURL)`)
                  delete (entryCopy as any).baseURL
                }
                if ((entryCopy as any).apiKey !== undefined) {
                  blockedExecutables.add(`${source} (provider ${id} apiKey)`)
                  delete (entryCopy as any).apiKey
                }
                if ((entryCopy as any).apiKeys !== undefined) {
                  blockedExecutables.add(`${source} (provider ${id} apiKeys)`)
                  delete (entryCopy as any).apiKeys
                }
                if (isRecord((entryCopy as any).headers)) {
                  blockedExecutables.add(`${source} (provider ${id} headers)`)
                  delete (entryCopy as any).headers
                }

                if (isRecord(entryCopy.options)) {
                  const optionsCopy = { ...entryCopy.options }
                  for (const optKey of Object.keys(optionsCopy)) {
                    if (isDangerousOption(optKey)) {
                      blockedExecutables.add(`${source} (provider ${id} options.${optKey})`)
                      delete optionsCopy[optKey]
                    }
                  }
                  entryCopy.options = optionsCopy
                }

                if (isRecord(entryCopy.models)) {
                  const modelsCopy: Record<string, any> = {}
                  for (const [modelId, modelEntry] of Object.entries(entryCopy.models)) {
                    if (!isRecord(modelEntry)) {
                      modelsCopy[modelId] = modelEntry
                      continue
                    }
                    const mCopy = { ...modelEntry }
                    if (isRecord(mCopy.provider)) {
                      const p = { ...(mCopy.provider as Record<string, any>) }
                      if (p.api !== undefined) {
                        blockedExecutables.add(`${source} (provider ${id} model ${modelId} api)`)
                        delete p.api
                      }
                      if (p.baseURL !== undefined) {
                        blockedExecutables.add(`${source} (provider ${id} model ${modelId} baseURL)`)
                        delete p.baseURL
                      }
                      mCopy.provider = p
                    }
                    if (isRecord(mCopy.headers)) {
                      blockedExecutables.add(`${source} (provider ${id} model ${modelId} headers)`)
                      delete mCopy.headers
                    }
                    if (isRecord(mCopy.options)) {
                      const mOptionsCopy = { ...mCopy.options }
                      for (const optKey of Object.keys(mOptionsCopy)) {
                        if (isDangerousOption(optKey)) {
                          blockedExecutables.add(`${source} (provider ${id} model ${modelId} options.${optKey})`)
                          delete mOptionsCopy[optKey]
                        }
                      }
                      mCopy.options = mOptionsCopy
                    }
                    modelsCopy[modelId] = mCopy
                  }
                  entryCopy.models = modelsCopy
                }

                sanitized[id] = entryCopy
              }
              return sanitized
            }

            if (safe.provider) safe.provider = sanitizeProviders(safe.provider) as typeof safe.provider
            if ((safe as any).providers) (safe as any).providers = sanitizeProviders((safe as any).providers)
          }

          return safe as Info
        }

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "YUKIOSHI_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.YUKIOSHI_CONFIG) {
          const source = Flag.YUKIOSHI_CONFIG
          const next = yield* loadFile(source, authEnv)
          const isProject = FSUtil.contains(trustRoot, ProjectTrust.canonical(source))
          yield* merge(source, isProject ? projectConfig(source, next) : next)
          yield* Effect.logDebug("loaded custom config", { path: Flag.YUKIOSHI_CONFIG })
        }

        if (!Flag.YUKIOSHI_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files(CONFIG_NAMES, ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, projectConfig(file, yield* loadFile(file, authEnv)), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directoryEntries = yield* ConfigPaths.directoryEntries(ctx.directory, ctx.worktree)
        const directories = directoryEntries.map((entry) => entry.path)

        if (Flag.YUKIOSHI_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from YUKIOSHI_CONFIG_DIR", { path: Flag.YUKIOSHI_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const entry of directoryEntries) {
          const dir = entry.path
          const isProject =
            entry.scope === "project" ||
            (entry.scope === "explicit" && FSUtil.contains(trustRoot, ProjectTrust.canonical(dir)))
          if (dir.endsWith(".opencode") || dir.endsWith(".yukioshi") || dir === Flag.YUKIOSHI_CONFIG_DIR) {
            for (const file of CONFIG_FILES) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              const next = yield* loadFile(source, authEnv)
              yield* merge(
                source,
                isProject ? projectConfig(source, next) : next,
                entry.scope === "global" ? "global" : entry.scope === "project" ? "local" : undefined,
              )
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (!isProject || projectTrusted || entry.scope === "explicit") {
            yield* ensureGitignore(dir).pipe(Effect.orDie)
          }

          // Install the dependencies a config directory declares for its local plugins. The plugin
          // API package is not published to npm, so it is never added here.
          if ((!isProject || projectTrusted) && (yield* fs.existsSafe(path.join(dir, "package.json")))) {
            const dep = yield* npmSvc
              .install(dir, { add: [] })
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }

          const dirCommands = yield* Effect.promise(() => ConfigCommand.load(dir))
          result.command = mergeDeep(
            result.command ?? {},
            isProject && !projectTrusted ? withoutShellCommands(dir, dirCommands) : dirCommands,
          )
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.yukioshi/plugin(s)` (or legacy `.opencode/plugin(s)`) are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          if (isProject && !projectTrusted) {
            if (list.length) blockedExecutables.add(`${dir} (plugins)`)
          } else {
            yield* mergePluginOrigins(dir, list, entry.scope === "global" ? "global" : undefined)
          }
        }

        if (process.env.YUKIOSHI_CONFIG_CONTENT) {
          const source = "YUKIOSHI_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.YUKIOSHI_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, projectConfig(source, next), "local")
          yield* Effect.logDebug("loaded custom config from YUKIOSHI_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["YUKIOSHI_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("YUKIOSHI_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        for (const managedDir of ConfigManaged.managedConfigDirs()) {
          if (existsSync(managedDir)) {
            for (const file of CONFIG_FILES) {
              const source = path.join(managedDir, file)
              yield* merge(source, yield* loadFile(source), "global")
            }
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (result.browser?.enabled) {
          const browserMcp: ConfigMCPV1.Local = {
            type: "local",
            command: [
              "npx",
              "-y",
              "@playwright/mcp@latest",
              "--isolated",
              ...(result.browser.headless !== false ? ["--headless"] : []),
              ...(result.browser.engine ? ["--browser", result.browser.engine] : []),
            ],
          }
          result.mcp = {
            browser: browserMcp,
            ...result.mcp,
          }
        }

        if (Flag.YUKIOSHI_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.YUKIOSHI_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("YUKIOSHI_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.YUKIOSHI_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.YUKIOSHI_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        if (blockedExecutables.size > 0) {
          yield* Effect.logWarning("project hooks and plugins are disabled until this project is explicitly trusted", {
            project: trustRoot,
            blocked: Array.from(blockedExecutables),
            command: `yukioshi trust ${JSON.stringify(trustRoot)}`,
          })
        }
        if (projectSkillPaths.size > 0) result.project_skill_paths = Array.from(projectSkillPaths)
        if (projectSkillUrls.size > 0) result.project_skill_urls = Array.from(projectSkillUrls)

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      const text = yield* readConfigFile(file)
      const original = text ? ConfigParse.jsonc(text, file) : writable(existing)
      yield* fs
        .writeFileString(
          file,
          JSON.stringify(mergeDeep(isRecord(original) ? original : writable(existing), writable(config)), null, 2),
        )
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.jsonc(before, file)
        ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(existing), file).value, file)
        const merged = mergeDeep(isRecord(existing) ? existing : {}, patch)
        const serialized = JSON.stringify(merged, null, 2)
        next = yield* decodeConfig(merged, file)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
      } else {
        const updated = patchJsonc(before, patch)
        next = yield* decodeConfig(ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
