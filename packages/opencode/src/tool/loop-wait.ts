import { Effect, Schema } from "effect"
import { SessionRepeat } from "../session/repeat"
import * as Tool from "./tool"

const DESCRIPTION =
  "Only for a self-paced /loop run: say how long to wait before the next run, with a short reason, or stop the loop with stop: true when nothing more is needed. The delay is kept between the loop's minimum interval and one hour. Refused outside a self-paced loop."

export const Parameters = Schema.Struct({
  seconds: Schema.optional(Schema.Number).annotate({
    description: "Seconds to wait before the next run (kept between loop.min_interval and 3600)",
  }),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Why this delay, in a few words; shown in the loop notice",
  }),
  stop: Schema.optional(Schema.Boolean).annotate({ description: "End the loop instead of waiting" }),
})

export function wait(sessionID: string, params: Schema.Schema.Type<typeof Parameters>) {
  const result = SessionRepeat.requestWait(sessionID, params)
  if (!result.ok) return { title: "loop_wait refused", output: result.message, metadata: {} }
  const w = result.wait
  return {
    title: w.stop ? "Loop will stop" : `Next run in ${SessionRepeat.duration((w.seconds ?? 0) * 1000)}`,
    output: w.stop ? "The loop will stop after this run." : `The next run starts in ${w.seconds} seconds.`,
    metadata: {},
  }
}

export const LoopWaitTool = Tool.define(
  "loop_wait",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.sync(() => wait(ctx.sessionID, params)),
  }),
)
