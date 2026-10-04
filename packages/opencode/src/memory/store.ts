// Explicit-only memory storage: three markdown files per project (general facts, environment
// facts, user corrections - see schema.ts) plus a small state.json. Design and on-disk format
// follow Kilo Code's packages/kilo-memory (MIT License), but this is a from-scratch, much smaller
// reimplementation - no auto-capture, no token-budgeted ranking, no session digests.
import fs from "fs/promises"
import path from "path"
import { MemoryMarkdown } from "./markdown"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"
import { MemorySlug } from "./slug"

export namespace MemoryStore {
  /** Default size limit for one project's memory, across all entries. */
  export const DEFAULT_MAX_CHARS = 4000
  /** Longest single entry: a memory is a sentence or two, not a document. */
  export const ENTRY_MAX = 500

  export type Saved = { key: string; changed: boolean; full?: { used: number; max: number } }

  function entrySize(entry: { key: string; text: string }) {
    return entry.key.length + entry.text.length
  }

  /** Characters used by all memory entries of a project. */
  export async function used(root: string) {
    let total = 0
    for (const name of MemorySchema.Sources)
      for (const entry of MemoryMarkdown.parse(await readSource(root, name))) total += entrySize(entry)
    return total
  }

  export type SearchHit = { source: MemorySchema.Source; section: string; key: string; text: string; score: number }

  const queues = new Map<string, Promise<unknown>>()

  // Serializes writes per memory root so concurrent remember/correct/forget calls on the same
  // project never interleave a read-modify-write cycle.
  function queue<A>(root: string, task: () => Promise<A>): Promise<A> {
    const prior = queues.get(root) ?? Promise.resolve()
    const next = prior.then(task, task)
    queues.set(
      root,
      next.catch(() => undefined),
    )
    return next
  }

  async function ensureDir(root: string) {
    await fs.mkdir(root, { recursive: true })
  }

  async function readFileSafe(file: string) {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      return ""
    }
  }

  export async function readSource(root: string, name: MemorySchema.Source): Promise<string> {
    return readFileSafe(MemoryPaths.source(root, name))
  }

  function defaultSection(name: MemorySchema.Source) {
    if (name === "corrections.md") return "Corrections"
    if (name === "environment.md") return "Environment"
    return "Facts"
  }

  export function remember(input: {
    root: string
    file: MemorySchema.Source
    text: string
    key?: string
    maxChars?: number
  }): Promise<Saved> {
    return queue(input.root, async () => {
      await ensureDir(input.root)
      const file = MemoryPaths.source(input.root, input.file)
      const key =
        input.key?.trim() || MemorySlug.safe(input.text, { max: MemorySlug.max.key, fallback: "note", lower: true })
      const current = await readFileSafe(file)
      const { text, changed } = MemoryMarkdown.upsert({
        text: current,
        section: defaultSection(input.file),
        line: MemoryMarkdown.line(key, input.text),
      })
      if (!changed) return { key, changed }
      // The size limit counts what memory would hold after this save (a replaced entry no longer counts).
      const max = input.maxChars ?? DEFAULT_MAX_CHARS
      const before = MemoryMarkdown.parse(current).reduce((sum, entry) => sum + entrySize(entry), 0)
      const after = MemoryMarkdown.parse(text).reduce((sum, entry) => sum + entrySize(entry), 0)
      const total = (await used(input.root)) - before + after
      if (total > max && after > before) return { key, changed: false, full: { used: total - after + before, max } }
      await fs.writeFile(file, text)
      return { key, changed }
    })
  }

  export function forget(input: { root: string; query: string }): Promise<{ removed: number; files: MemorySchema.Source[] }> {
    const needle = input.query.trim().toLowerCase()
    return queue(input.root, async () => {
      await ensureDir(input.root)
      let removed = 0
      const touched: MemorySchema.Source[] = []
      for (const name of MemorySchema.Sources) {
        const file = MemoryPaths.source(input.root, name)
        const current = await readFileSafe(file)
        if (!current) continue
        const result = MemoryMarkdown.remove({
          text: current,
          match: (entry) =>
            entry.key.toLowerCase() === needle ||
            entry.key.toLowerCase().includes(needle) ||
            entry.text.toLowerCase().includes(needle),
        })
        if (result.count === 0) continue
        removed += result.count
        touched.push(name)
        await fs.writeFile(file, result.text)
      }
      return { removed, files: touched }
    })
  }

  export async function search(input: { root: string; query: string; limit: number }): Promise<SearchHit[]> {
    const terms = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (terms.length === 0) return []
    const hits: SearchHit[] = []
    for (const name of MemorySchema.Sources) {
      const text = await readSource(input.root, name)
      for (const entry of MemoryMarkdown.parse(text)) {
        const haystack = `${entry.key} ${entry.text}`.toLowerCase()
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
        if (score === 0) continue
        hits.push({ source: name, section: entry.section, key: entry.key, text: entry.text, score })
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, input.limit)
  }

  export async function catalog(input: { root: string; query?: string }) {
    const filter = input.query?.trim().toLowerCase() ?? ""
    const bySource: Partial<Record<MemorySchema.Source, MemoryMarkdown.Entry[]>> = {}
    let count = 0
    for (const name of MemorySchema.Sources) {
      const text = await readSource(input.root, name)
      const entries = MemoryMarkdown.parse(text).filter(
        (entry) => !filter || `${entry.key} ${entry.text}`.toLowerCase().includes(filter),
      )
      if (entries.length === 0) continue
      bySource[name] = entries
      count += entries.length
    }
    return { bySource, count }
  }
}
