export * as ConfigBudgetV1 from "./budget"

import { Schema } from "effect"
import { NonNegativeInt } from "../../schema"

const Amount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))

export const Info = Schema.Struct({
  session: Schema.optional(Amount).annotate({ description: "Maximum dollar cost for one session" }),
  daily: Schema.optional(Amount).annotate({ description: "Maximum dollar cost across sessions today" }),
  monthly: Schema.optional(Amount).annotate({ description: "Maximum dollar cost across sessions this month" }),
  tokens: Schema.optional(
    Schema.Struct({
      session: Schema.optional(NonNegativeInt),
      daily: Schema.optional(NonNegativeInt),
      monthly: Schema.optional(NonNegativeInt),
    }),
  ).annotate({ description: "Token limits for providers without usable prices" }),
})

export type Info = Schema.Schema.Type<typeof Info>
