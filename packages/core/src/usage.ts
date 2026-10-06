export type UsageTotals = { cost: number; tokens: number }

export type UsageRow = {
  id: string
  parentID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
  }
  time: { created: number; updated: number }
}

export function usageTotals(rows: UsageRow[], since?: number, rootID?: string): UsageTotals {
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.parentID) continue
    const list = children.get(row.parentID) ?? []
    list.push(row.id)
    children.set(row.parentID, list)
  }

  const included = rootID
    ? (() => {
        const set = new Set([rootID])
        const pending = [rootID]
        while (pending.length) {
          const next = children.get(pending.pop()!) ?? []
          for (const id of next) {
            if (set.has(id)) continue
            set.add(id)
            pending.push(id)
          }
        }
        return set
      })()
    : undefined

  return rows.reduce<UsageTotals>(
    (sum, row) => {
      if (since !== undefined && row.time.updated < since) return sum
      if (included && !included.has(row.id)) return sum
      const tokens = row.tokens
      return {
        cost: sum.cost + (row.cost ?? 0),
        tokens: sum.tokens + (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
      }
    },
    { cost: 0, tokens: 0 },
  )
}
