import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ConfigPermissionV1 } from "@yukioshi/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@yukioshi/core/util/wildcard"
import { Cause, Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SafetyGuards } from "@yukioshi/core/permission/guards"
import { RiskClassifier } from "@yukioshi/core/permission/risk"
import { Hooks } from "@/hooks"
import { Config } from "@/config/config"
import { Permission as PermissionSchema } from "@yukioshi/schema/permission"
import type { PermissionReview } from "./review"

export const Event = PermissionV1.Event

/**
 * Same manual/auto/auto-all/plan modes as PermissionV2 (packages/core/src/permission.ts),
 * duplicated as a plain literal type rather than shared to avoid coupling this
 * legacy V1 service to the V2 schema module. Kept in sync by hand.
 */
export type Mode = "manual" | "auto" | "auto-all" | "plan" | "review"
const DEFAULT_MODE: Mode = "manual"

/** Decides an action for a session in review mode; the session layer provides it (see ./review). */
export type Reviewer = (request: PermissionV1.Request) => Effect.Effect<PermissionReview.Verdict>

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  readonly getMode: (sessionID: PermissionV1.Request["sessionID"]) => Effect.Effect<Mode>
  readonly setMode: (sessionID: PermissionV1.Request["sessionID"], mode: Mode) => Effect.Effect<void>
  readonly setReviewer: (reviewer: Reviewer | undefined) => Effect.Effect<void>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  modes: Map<PermissionV1.Request["sessionID"], Mode>
}

function guardResources(
  request: Pick<PermissionV1.Request, "permission" | "patterns" | "metadata">,
): readonly string[] {
  const command = request.metadata?.["command"]
  if (request.permission === "bash" && typeof command === "string") return [command, ...request.patterns]
  return request.patterns
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const hooks = yield* Hooks.Service
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          modes: new Map<PermissionV1.Request["sessionID"], Mode>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    // A mode set through the API (`yukioshi run --mode`, the session permission mode endpoint) is kept by the
    // newer permission service. Follow it here as well, so the mode holds for every tool call: without this,
    // `--mode plan` would let through anything the rules allow.
    const apiModes = new Map<string, Mode>()
    let reviewer: Reviewer | undefined
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type !== PermissionSchema.Event.ModeChanged.type) return
        const data = event.data as { sessionID: string; mode: Mode }
        apiModes.set(data.sessionID, data.mode)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending, modes } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input

      // Hard safety blocks: cannot be bypassed by any configured rule,
      // saved approval, or permission mode (including auto-all). Mirrors
      // PermissionV2's evaluateInput (packages/core/src/permission.ts).
      const hardBlock = SafetyGuards.check(request.permission, guardResources(request))
      if (hardBlock) {
        yield* Effect.logWarning("hard safety block", { permission: request.permission, reason: hardBlock.reason })
        return yield* new PermissionV1.DeniedError({
          ruleset: [{ permission: request.permission, pattern: "*", action: "deny" }],
        })
      }

      const mode = modes.get(request.sessionID) ?? apiModes.get(request.sessionID) ?? DEFAULT_MODE
      const risk = RiskClassifier.classify(request.permission)

      // Plan mode: only low-risk (read-only) actions proceed, regardless of
      // what the configured ruleset would otherwise allow.
      if (mode === "plan" && risk !== "low") {
        return yield* new PermissionV1.DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          mode: "plan",
        })
      }

      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        // Auto/auto-all modes only ever resolve an "ask" toward "allow" -
        // they never override an explicit deny rule from above.
        if (mode === "auto-all") continue
        if (mode === "auto" && risk === "low") continue
        needsAsk = true
      }

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }

      // Review mode: a reviewer model decides every action that is not low-risk, even one the rules allow
      // (deny rules and hard blocks were checked above). If it cannot decide, a person is asked, which an
      // unattended run answers with a refusal.
      if (mode === "review" && risk !== "low") {
        const verdict: PermissionReview.Verdict = reviewer
          ? yield* reviewer(info).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("permission review failed", { cause }).pipe(
                      Effect.as({ verdict: "ask" as const, reason: "The review failed." }),
                    ),
              ),
            )
          : { verdict: "ask", reason: "No reviewer is available." }
        yield* Effect.logInfo("reviewed", {
          permission: info.permission,
          verdict: verdict.verdict,
          reason: verdict.reason,
        })
        if (verdict.verdict === "allow") return
        if (verdict.verdict === "deny") return yield* new PermissionV1.ReviewedError({ reason: verdict.reason })
        needsAsk = true
      }

      if (!needsAsk) return

      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      // Notification hooks never decide anything (unlike PreToolUse) - run them, but
      // their own per-hook timeoutMs already bounds how long this can take.
      const instance = yield* InstanceState.context
      const cwd = instance.worktree === "/" ? instance.directory : instance.worktree
      const cfg = yield* config.get()
      yield* hooks.run({
        hooks: cfg.hooks,
        event: "Notification",
        payload: {
          session_id: request.sessionID,
          message: `YukiOshi Code needs your permission: ${request.permission}`,
          tool_name: request.permission,
          risk,
        },
        cwd,
        toolName: request.permission,
      })

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const getMode = Effect.fn("Permission.getMode")(function* (sessionID: PermissionV1.Request["sessionID"]) {
      const modes = (yield* InstanceState.get(state)).modes
      return modes.get(sessionID) ?? apiModes.get(sessionID) ?? DEFAULT_MODE
    })

    const setMode = Effect.fn("Permission.setMode")(function* (
      sessionID: PermissionV1.Request["sessionID"],
      mode: Mode,
    ) {
      const modes = (yield* InstanceState.get(state)).modes
      modes.set(sessionID, mode)
    })

    const setReviewer = Effect.fn("Permission.setReviewer")(function* (next: Reviewer | undefined) {
      reviewer = next
    })

    return Service.of({ ask, reply, list, getMode, setMode, setReviewer })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Hooks.node, Config.node] })

export * as Permission from "."
