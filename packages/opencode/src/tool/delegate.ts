import { Effect, Exit, Schema } from "effect"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "./truncate"
import * as Tool from "./tool"
import DESCRIPTION from "./delegate.txt"
import { runDelegate } from "@/delegate/client"
import type { PermissionOption, RequestPermissionOutcome, ToolCallUpdate } from "@agentclientprotocol/sdk"

export const Parameters = Schema.Struct({
  agent: Schema.String.annotate({
    description: "The name of the configured external agent to delegate to",
  }),
  prompt: Schema.String.annotate({
    description: "The task or prompt for the external agent to perform",
  }),
})

/**
 * The other agent's option that matches the user's answer, for this one request only: picking an "always"
 * option would make that agent remember a standing permission in its own settings, beyond what the user
 * approved here. With no matching option the request is cancelled, never allowed.
 */
export function permissionAnswer(options: readonly PermissionOption[], allowed: boolean): RequestPermissionOutcome {
  const kinds = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
  const option = kinds.map((kind) => options.find((o) => o.kind === kind)).find(Boolean)
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" }
}

export const DelegateTool = Tool.define(
  "delegate",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const truncate = yield* Truncate.Service
    const agent = yield* Agent.Service

    const run = Effect.fn("DelegateTool.run")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const delegateConfig = cfg.delegate
      const agents = delegateConfig?.agents ?? {}
      const agentConfig = agents[params.agent]

      if (!agentConfig) {
        const available = Object.keys(agents).join(", ")
        return yield* Effect.fail(
          new Error(`Agent "${params.agent}" is not configured. Available agents: ${available || "none"}`),
        )
      }

      // Request permission for the delegation tool itself
      yield* ctx.ask({
        permission: "delegate",
        patterns: [params.agent],
        always: [params.agent],
        metadata: {
          agent: params.agent,
          prompt: params.prompt,
        },
      })

      const bridge = yield* EffectBridge.make()
      const ins = yield* InstanceState.context
      const cwd = ins.directory

      const onProgress = (title: string, metadata?: Record<string, unknown>) => {
        bridge.promise(ctx.metadata({ title, metadata }))
      }

      const askPermission = async (
        toolCall: ToolCallUpdate,
        options: PermissionOption[],
      ): Promise<RequestPermissionOutcome> => {
        const action = toolCall.title || toolCall.kind || "external action"
        const exit = await bridge.promise(
          Effect.exit(
            ctx.ask({
              permission: "delegate",
              patterns: [params.agent],
              always: [params.agent],
              metadata: {
                agent: params.agent,
                toolCallId: toolCall.toolCallId,
                action,
                title: toolCall.title,
                kind: toolCall.kind,
                rawInput: (toolCall as any).rawInput,
              },
            }),
          ),
        )

        return permissionAnswer(options, Exit.isSuccess(exit))
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          runDelegate({
            agentName: params.agent,
            agentConfig,
            prompt: params.prompt,
            cwd,
            abortSignal: ctx.abort,
            onProgress,
            askPermission,
          }),
        catch: (err: any) => (err instanceof Error ? err : new Error(String(err))),
      })

      let outputText = result.finalMessage || `Agent "${params.agent}" completed with stopReason: ${result.stopReason}`
      if (result.filesChanged.length > 0) {
        outputText += `\n\nFiles changed:\n${result.filesChanged.map((f) => `- ${f}`).join("\n")}`
      }

      const agentInfo = yield* agent.get(ctx.agent)
      const truncated = yield* truncate.output(outputText, {}, agentInfo)

      return {
        title: `Delegate: ${params.agent}`,
        metadata: {
          agent: params.agent,
          filesChanged: result.filesChanged,
          stopReason: result.stopReason,
          truncated: truncated.truncated,
          ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
        },
        output: truncated.content,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
