import type { GraphNeighbor, GraphRelation, GraphSymbol, ImportantFile } from "./contracts"

type Edge = { readonly to: string; readonly relation: GraphRelation }

const inverse: Record<GraphRelation, GraphRelation> = {
  imports: "imported_by",
  imported_by: "imports",
  calls: "called_by",
  called_by: "calls",
  tests: "tested_by",
  tested_by: "tests",
  contains: "related",
  related: "related",
}

/** Small provider-neutral graph store shared by all implementations. */
export class GraphStore {
  private readonly adjacency = new Map<string, Edge[]>()
  private readonly symbols: GraphSymbol[] = []
  private edgeCount = 0

  addFile(path: string) {
    if (!this.adjacency.has(path)) this.adjacency.set(path, [])
  }

  addEdge(from: string, to: string, relation: GraphRelation) {
    if (from === to) return
    this.addFile(from)
    this.addFile(to)
    const edges = this.adjacency.get(from)!
    if (edges.some((edge) => edge.to === to && edge.relation === relation)) return
    edges.push({ to, relation })
    this.adjacency.get(to)!.push({ to: from, relation: inverse[relation] })
    this.edgeCount += 1
  }

  addSymbol(symbol: GraphSymbol) {
    this.addFile(symbol.path)
    this.symbols.push(symbol)
  }

  get nodeCount() {
    return this.adjacency.size
  }

  get edges() {
    return this.edgeCount
  }

  findSymbols(text: string, limit: number) {
    const needle = text.trim().toLowerCase()
    if (!needle || limit <= 0) return []
    return this.symbols
      .map((symbol) => {
        const name = symbol.name.toLowerCase()
        const match = name === needle ? 3 : name.startsWith(needle) ? 2 : name.includes(needle) ? 1 : 0
        return { symbol, score: match + (symbol.exported ? 0.5 : 0) }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length)
      .slice(0, limit)
      .map((item) => item.symbol)
  }

  neighbors(path: string, depth: number, limit: number): GraphNeighbor[] {
    if (depth <= 0 || limit <= 0) return []
    const output: GraphNeighbor[] = []
    const seen = new Set([path])
    let frontier = [{ path, relation: "related" as GraphRelation }]
    for (let distance = 1; distance <= depth && frontier.length > 0; distance += 1) {
      const next: typeof frontier = []
      for (const node of frontier) {
        for (const edge of this.adjacency.get(node.path) ?? []) {
          if (seen.has(edge.to)) continue
          seen.add(edge.to)
          const relation = distance === 1 ? edge.relation : node.relation
          output.push({ path: edge.to, relation, distance, ...(distance > 1 ? { via: node.path } : {}) })
          next.push({ path: edge.to, relation })
          if (output.length >= limit) return output
        }
      }
      frontier = next
    }
    return output
  }

  shortestPath(from: string, to: string, maxDepth = 8) {
    if (!this.adjacency.has(from) || !this.adjacency.has(to)) return undefined
    const previous = new Map<string, string | null>([[from, null]])
    let frontier = [from]
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const node of frontier) {
        for (const edge of this.adjacency.get(node) ?? []) {
          if (previous.has(edge.to)) continue
          previous.set(edge.to, node)
          if (edge.to === to) {
            const result = [to]
            let cursor: string | null | undefined = node
            while (cursor) {
              result.unshift(cursor)
              cursor = previous.get(cursor)
            }
            return result
          }
          next.push(edge.to)
        }
      }
      frontier = next
    }
    return undefined
  }

  importantFiles(limit: number): ImportantFile[] {
    return [...this.adjacency.entries()]
      .map(([path, edges]) => ({ path, score: edges.length }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(0, limit))
  }
}
