// Local audit log ("audit": { "enabled": true } in your own global config): one JSON line for each tool call and
// for each approval prompt and its answer, appended to <state>/audit/<date>.jsonl. Nothing leaves the machine.
// Only the global config turns it on or off, so a project cannot switch it off, and secrets in what is recorded
// are masked.

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@yukioshi/core/global"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Redact } from "@yukioshi/core/redact"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"

const TEXT_MAX = 500

export function root(state = Global.Path.state) {
  return path.join(state, "audit")
}

/** The day's log file, named after the local date. */
export function file(time: Date, dir = root()) {
  const day = [time.getFullYear(), time.getMonth() + 1, time.getDate()].map((n) => String(n).padStart(2, "0")).join("-")
  return path.join(dir, `${day}.jsonl`)
}

function short(text: string) {
  const masked = Redact.mask(text)
  return masked.length > TEXT_MAX ? `${masked.slice(0, TEXT_MAX)}…` : masked
}

/** The part of a tool's input worth recording: its command, file, URL, or pattern, masked and shortened. */
export function summarize(input: Record<string, unknown> | undefined) {
  const value = input ?? {}
  for (const key of ["command", "filePath", "filepath", "path", "url", "pattern", "query", "description"]) {
    if (typeof value[key] === "string") return short(value[key] as string)
  }
  return short(JSON.stringify(value))
}

type ToolPart = {
  id: string
  sessionID: string
  type: string
  tool?: string
  state?: { status: string; input?: Record<string, unknown>; error?: string }
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Audit") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("Audit.state")(function* (ctx) {
        if ((yield* config.getGlobal()).audit?.enabled !== true) return {}
        const recorded = new Set<string>()
        const write = (entry: Record<string, unknown>) =>
          Effect.promise(async () => {
            const now = new Date()
            const target = file(now)
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
            await fs.appendFile(
              target,
              JSON.stringify({ time: now.toISOString(), directory: ctx.directory, ...entry }) + "\n",
              { mode: 0o600 },
            )
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("audit log write failed", { cause })))

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          if (event.type === "message.part.updated") {
            const part = (event.data as { part: ToolPart }).part
            const status = part.state?.status
            if (part.type !== "tool" || (status !== "completed" && status !== "error")) return Effect.void
            if (recorded.has(part.id)) return Effect.void
            recorded.add(part.id)
            return write({
              event: "tool",
              session: part.sessionID,
              tool: part.tool,
              status,
              input: summarize(part.state?.input),
              ...(status === "error" ? { error: short(String(part.state?.error ?? "")) } : {}),
            })
          }
          if (event.type === "permission.asked") {
            const data = event.data as { sessionID: string; permission: string; patterns: string[] }
            return write({
              event: "permission.asked",
              session: data.sessionID,
              permission: data.permission,
              patterns: data.patterns.slice(0, 8).map(short),
            })
          }
          if (event.type === "permission.replied") {
            const data = event.data as { sessionID: string; reply: string }
            return write({ event: "permission.replied", session: data.sessionID, reply: data.reply })
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return {}
      }),
    )

    const init = Effect.fn("Audit.init")(function* () {
      yield* InstanceState.get(state)
    })
    return Service.of({ init })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, EventV2Bridge.node] })

export * as Audit from "./index"
