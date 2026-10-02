export * as Verification from "./verification"

import { Schema } from "effect"
import { optional } from "./schema"

export const STATUSES = [
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "FAILED",
  "UNAVAILABLE",
  "SKIPPED_BY_USER",
] as const

export const Status = Schema.Literals(STATUSES).annotate({ identifier: "Verification.Status" })
export type Status = Schema.Schema.Type<typeof Status>

export const CheckKind = Schema.Literals([
  "syntax",
  "diagnostics",
  "typecheck",
  "lint",
  "test",
  "build",
  "diff",
]).annotate({ identifier: "Verification.CheckKind" })
export type CheckKind = Schema.Schema.Type<typeof CheckKind>

export const CheckStatus = Schema.Literals([
  "passed",
  "failed",
  "error",
  "skipped",
  "unavailable",
]).annotate({ identifier: "Verification.CheckStatus" })
export type CheckStatus = Schema.Schema.Type<typeof CheckStatus>

export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  kind: CheckKind,
  label: Schema.String,
  status: CheckStatus,
  command: Schema.String.pipe(optional),
  exitCode: Schema.Number.pipe(optional),
  durationMs: Schema.Number,
  evidence: Schema.String,
}).annotate({ identifier: "Verification.Check" })

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  status: Status,
  checks: Schema.Array(Check),
  explanation: Schema.String,
}).annotate({ identifier: "Verification.Summary" })
