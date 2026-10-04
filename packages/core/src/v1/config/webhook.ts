import { Schema } from "effect"

export const Event = Schema.Literals(["turn.finished", "turn.failed", "permission.asked", "question.asked"])
export type Event = typeof Event.Type

export const Info = Schema.Struct({
  url: Schema.String,
  events: Schema.optional(Schema.Array(Event)),
  secret: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type Info = typeof Info.Type

export * as ConfigWebhookV1 from "./webhook"
