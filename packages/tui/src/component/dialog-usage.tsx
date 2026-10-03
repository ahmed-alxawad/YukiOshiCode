import { TextAttributes } from "@opentui/core"
import type { AssistantMessage, GlobalSession } from "@yukioshi/sdk/v2"
import { For, Show, createMemo, createResource } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { Locale } from "../util/locale"

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 200

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

type Totals = { sessions: number; tokens: number; cost: number }

export type UsagePeriod = { label: string; since: number }

export function usagePeriods(now: number): UsagePeriod[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return [
    { label: "Today", since: midnight.getTime() },
    { label: "Last 7 days", since: now - 7 * DAY_MS },
    { label: "Last 30 days", since: now - 30 * DAY_MS },
  ]
}

/** Adds up tokens and cost per period, counting a session in every period it was active in. */
export function usageTotals(
  sessions: Pick<GlobalSession, "cost" | "tokens" | "time">[],
  periods: UsagePeriod[],
): Totals[] {
  return periods.map((period) =>
    sessions
      .filter((session) => session.time.updated >= period.since)
      .reduce<Totals>(
        (sum, session) => {
          const tokens = session.tokens
          return {
            sessions: sum.sessions + 1,
            tokens: sum.tokens + (tokens ? tokens.input + tokens.output + tokens.reasoning : 0),
            cost: sum.cost + (session.cost ?? 0),
          }
        },
        { sessions: 0, tokens: 0, cost: 0 },
      ),
  )
}

export function DialogUsage() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const { theme } = useTheme()
  const dialog = useDialog()

  const periods = usagePeriods(Date.now())

  // Every session, in every project, updated within the longest period.
  const [history] = createResource(async () => {
    const since = periods[periods.length - 1]!.since
    const sessions: GlobalSession[] = []
    let cursor: number | undefined
    while (true) {
      const { data } = await sdk.client.experimental.session.list({ start: since, cursor, limit: PAGE_SIZE, archived: true })
      if (!data?.length) break
      sessions.push(...data)
      if (data.length < PAGE_SIZE) break
      cursor = data[data.length - 1]!.time.updated
    }
    return usageTotals(sessions, periods)
  })

  const current = createMemo(() => {
    if (route.data.type !== "session") return
    const session = sync.session.get(route.data.sessionID)
    if (!session) return
    const messages = sync.data.message[session.id] ?? []
    const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    const model = last ? sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID] : undefined
    const context = last
      ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
      : 0
    const tokens = session.tokens
    return {
      model: last ? (model?.name ?? `${last.providerID}/${last.modelID}`) : undefined,
      context,
      contextLimit: model?.limit.context,
      input: tokens?.input ?? 0,
      output: (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
      cached: tokens?.cache.read ?? 0,
      cost: session.cost ?? 0,
    }
  })

  const row = (label: string, value: string) => (
    <box flexDirection="row" gap={2}>
      <text fg={theme.textMuted} width={16} flexShrink={0}>
        {label}
      </text>
      <text fg={theme.text}>{value}</text>
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show when={current()} fallback={<text fg={theme.textMuted}>Open a session to see its usage.</text>}>
        {(session) => (
          <box>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              This session
            </text>
            <Show when={session().model}>{(model) => row("Model", model())}</Show>
            {row(
              "Context",
              session().contextLimit
                ? `${Locale.number(session().context)} of ${Locale.number(session().contextLimit!)} tokens (${Math.round((session().context / session().contextLimit!) * 100)}%)`
                : `${Locale.number(session().context)} tokens`,
            )}
            {row("Input", `${Locale.number(session().input)} tokens`)}
            {row("Output", `${Locale.number(session().output)} tokens`)}
            <Show when={session().cached > 0}>{row("Cached", `${Locale.number(session().cached)} tokens`)}</Show>
            {row("Cost", money.format(session().cost))}
          </box>
        )}
      </Show>

      <box>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          All projects
        </text>
        <Show
          when={history()}
          fallback={<text fg={theme.textMuted}>{history.error ? "Usage history is unavailable." : "Loading…"}</text>}
        >
          {(totals) => (
            <For each={periods}>
              {(period, index) => {
                const total = totals()[index()]!
                return row(
                  period.label,
                  `${Locale.number(total.tokens)} tokens · ${money.format(total.cost)} · ${total.sessions} ${total.sessions === 1 ? "session" : "sessions"}`,
                )
              }}
            </For>
          )}
        </Show>
      </box>

      <text fg={theme.textMuted} wrapMode="word">
        Costs are estimates from each model's list price. Subscription sign-ins (ChatGPT, SuperGrok) count against
        your plan's own limits, shown on the provider's account page.
      </text>
    </box>
  )
}
