import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { usageTotals, type UsageRow } from "@yukioshi/core/usage"
import { SessionTable } from "@yukioshi/core/session/sql"
import type { ConfigBudgetV1 } from "@yukioshi/core/v1/config/budget"
import { Context, Effect, Layer } from "effect"
import { Config } from "./config/config"
import { Database } from "@yukioshi/core/database/database"

type BudgetConfig = ConfigBudgetV1.Info
type LimitKind = "session" | "daily" | "monthly"
type Unit = "cost" | "tokens"

export type BudgetUsage = { cost: number; tokens: number }
export type BudgetDecision = { allowed: boolean; warning?: string; exceeded?: string; usage: BudgetUsage }

function startOfDay(now: number) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfMonth(now: number) {
  const date = new Date(now)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function money(value: number) {
  return `$${value.toFixed(2)}`
}

function capitalize(value: string) {
  return value[0]!.toUpperCase() + value.slice(1)
}

export function evaluateBudget(input: {
  config?: BudgetConfig
  session: BudgetUsage
  daily: BudgetUsage
  monthly: BudgetUsage
  warned: Set<string>
}): BudgetDecision {
  const checks: Array<{ kind: LimitKind; unit: Unit; limit: number; used: number }> = []
  for (const kind of ["session", "daily", "monthly"] as const) {
    const usage = input[kind]
    const dollarLimit = input.config?.[kind]
    if (dollarLimit !== undefined) checks.push({ kind, unit: "cost", limit: dollarLimit, used: usage.cost })
    const tokenLimit = input.config?.tokens?.[kind]
    if (tokenLimit !== undefined) checks.push({ kind, unit: "tokens", limit: tokenLimit, used: usage.tokens })
  }

  const exceeded = checks.find((check) => check.used >= check.limit)
  if (exceeded) {
    const amount = exceeded.unit === "cost" ? money(exceeded.used) : `${exceeded.used.toLocaleString()} tokens`
    const limit = exceeded.unit === "cost" ? money(exceeded.limit) : `${exceeded.limit.toLocaleString()} tokens`
    return {
      allowed: false,
      exceeded: `${capitalize(exceeded.kind)} budget of ${limit} reached (${amount} used). Raise budget.${exceeded.kind} in yukioshi.json to continue.`,
      usage: input.session,
    }
  }

  const warnings: string[] = []
  for (const check of checks) {
    if (check.limit <= 0 || check.used < check.limit * 0.8) continue
    const key = `${check.kind}:${check.unit}`
    if (input.warned.has(key)) continue
    input.warned.add(key)
    const amount = check.unit === "cost" ? money(check.used) : `${check.used.toLocaleString()} tokens`
    const limit = check.unit === "cost" ? money(check.limit) : `${check.limit.toLocaleString()} tokens`
    warnings.push(`${capitalize(check.kind)} budget is at 80% (${amount} of ${limit} used).`)
  }
  return { allowed: true, warning: warnings.join(" ") || undefined, usage: input.session }
}

export interface Interface {
  readonly check: (sessionID: string) => Effect.Effect<BudgetDecision>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Budget") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const warned = new Map<string, Set<string>>()
    const check = Effect.fn("Budget.check")(function* (sessionID: string) {
      const cfg = yield* config.get()
      if (!cfg.budget) return { allowed: true, usage: { cost: 0, tokens: 0 } } satisfies BudgetDecision
      const rows = yield* database.db
        .select({
          id: SessionTable.id,
          parentID: SessionTable.parent_id,
          cost: SessionTable.cost,
          tokens: {
            input: SessionTable.tokens_input,
            output: SessionTable.tokens_output,
            reasoning: SessionTable.tokens_reasoning,
          },
          time: { created: SessionTable.time_created, updated: SessionTable.time_updated },
        })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const normalized = rows as UsageRow[]
      const now = Date.now()
      const session = usageTotals(normalized, undefined, sessionID)
      const daily = usageTotals(normalized, startOfDay(now))
      const monthly = usageTotals(normalized, startOfMonth(now))
      const sessionWarnings = warned.get(sessionID) ?? new Set<string>()
      warned.set(sessionID, sessionWarnings)
      return evaluateBudget({ config: cfg.budget, session, daily, monthly, warned: sessionWarnings })
    })
    return { check }
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Config.node] })

export * as Budget from "./budget"
