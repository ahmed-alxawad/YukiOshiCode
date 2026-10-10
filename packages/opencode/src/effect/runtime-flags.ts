import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("YUKIOSHI_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@yukioshi/RuntimeFlags", {
  autoShare: bool("YUKIOSHI_AUTO_SHARE"),
  pure: bool("YUKIOSHI_PURE"),
  disableDefaultPlugins: bool("YUKIOSHI_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("YUKIOSHI_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("YUKIOSHI_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("YUKIOSHI_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("YUKIOSHI_DISABLE_CLAUDE_CODE"),
    direct: bool("YUKIOSHI_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("YUKIOSHI_DISABLE_CLAUDE_CODE"),
    direct: bool("YUKIOSHI_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("YUKIOSHI_ENABLE_EXA"),
    legacy: bool("YUKIOSHI_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("YUKIOSHI_ENABLE_PARALLEL"),
    legacy: bool("YUKIOSHI_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  backgroundShell: bool("YUKIOSHI_BACKGROUND_SHELL"),
  enableExperimentalModels: bool("YUKIOSHI_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("YUKIOSHI_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("YUKIOSHI_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_ICON_DISCOVERY"),
  experimentalParallelTasks: enabledByExperimental("YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS"),
  outputTokenMax: positiveInteger("YUKIOSHI_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("YUKIOSHI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("YUKIOSHI_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("YUKIOSHI_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("YUKIOSHI_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
