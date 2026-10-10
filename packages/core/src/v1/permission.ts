export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@yukioshi/schema/permission-v1"
import { ID } from "@yukioshi/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

/** Review mode: the reviewer model refused the action. The agent sees why and can choose another way. */
export class ReviewedError extends Schema.TaggedErrorClass<ReviewedError>()("PermissionReviewedError", {
  reason: Schema.String,
}) {
  override get message() {
    return `An automatic reviewer denied this tool call: ${this.reason}. Take a safer approach that fits the request, or stop and explain what you need.`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
  /** Set when a permission mode, not a rule, refused the call. */
  mode: Schema.optional(Schema.String),
}) {
  override get message() {
    if (this.mode === "plan")
      return "Plan mode refused this tool call: plan mode only allows read-only actions. Keep planning with read-only tools, or ask the user to leave plan mode."
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError | ReviewedError
