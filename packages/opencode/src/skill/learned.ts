// Learned skills (skills.learn): procedures the agent saves for itself with the skill_save tool, kept in
// YukiOshi's data folder (never in the project). The curator keeps the set small and useful: it refuses a
// skill that repeats an existing one, retires skills nobody has loaded for a long time, and caps the count
// by retiring the least used. Retired skills move to `.archive`, so nothing is ever deleted.

import fs from "fs/promises"
import path from "path"
import { Global } from "@yukioshi/core/global"

export const DEFAULT_MAX = 30
export const DEFAULT_STALE_DAYS = 90
export const NAME_MAX = 64
export const DESCRIPTION_MAX = 300
export const CONTENT_MAX = 12_000
const SIMILAR = 0.6
const DAY = 24 * 60 * 60 * 1000

export interface Entry {
  readonly created: number
  readonly updated: number
  readonly uses: number
  readonly lastUsed?: number
}

type Index = Record<string, Entry>

type LearnConfig = boolean | { enabled?: boolean; max?: number; stale_days?: number } | undefined

/** `skills.learn` as `true` or `{ enabled, max, stale_days }`; off unless turned on. */
export function settings(learn: LearnConfig) {
  const options = typeof learn === "object" ? learn : {}
  return {
    enabled: learn === true || (typeof learn === "object" && learn.enabled === true),
    max: options.max ?? DEFAULT_MAX,
    staleDays: options.stale_days ?? DEFAULT_STALE_DAYS,
  }
}

export function root(data = Global.Path.data) {
  return path.join(data, "skills", "learned")
}

const indexFile = (dir: string) => path.join(dir, "index.json")

export async function readIndex(dir: string): Promise<Index> {
  const text = await fs.readFile(indexFile(dir), "utf8").catch(() => undefined)
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" ? (value as Index) : {}
  } catch {
    return {}
  }
}

async function writeIndex(dir: string, index: Index) {
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${indexFile(dir)}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(index, null, 2))
  await fs.rename(tmp, indexFile(dir))
}

/** Lowercase words joined by single hyphens, like the bundled skills. */
export function validName(name: string) {
  return name.length > 0 && name.length <= NAME_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

function words(text: string) {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
}

/** Overlap of the words in two descriptions, from 0 (none shared) to 1 (the same words). */
export function similarity(a: string, b: string) {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

function document(name: string, description: string, content: string) {
  const safe = description.replace(/\s+/g, " ").trim()
  return `---\nname: ${name}\ndescription: ${JSON.stringify(safe)}\n---\n\n${content.trim()}\n`
}

async function descriptionOf(dir: string, name: string) {
  const text = await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => "")
  const match = text.match(/^description:\s*(.*)$/m)
  if (!match) return ""
  const raw = match[1]!.trim()
  try {
    return raw.startsWith('"') ? String(JSON.parse(raw)) : raw
  } catch {
    return raw
  }
}

async function archive(dir: string, name: string, now: number) {
  const target = path.join(dir, ".archive", `${name}-${now}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(path.join(dir, name), target).catch(() => undefined)
}

export type SaveResult =
  | { readonly status: "saved" | "updated"; readonly retired: string[] }
  | { readonly status: "similar"; readonly similar: string }

export async function save(
  dir: string,
  input: { name: string; description: string; content: string; max?: number; staleDays?: number },
  now = Date.now(),
): Promise<SaveResult> {
  const index = await readIndex(dir)
  const existing = index[input.name]
  if (!existing) {
    for (const other of Object.keys(index)) {
      if (similarity(input.description, await descriptionOf(dir, other)) >= SIMILAR)
        return { status: "similar", similar: other }
    }
  }
  if (existing) await archive(dir, input.name, now)
  await fs.mkdir(path.join(dir, input.name), { recursive: true })
  await fs.writeFile(path.join(dir, input.name, "SKILL.md"), document(input.name, input.description, input.content))
  index[input.name] = existing ? { ...existing, updated: now } : { created: now, updated: now, uses: 0 }
  await writeIndex(dir, index)
  const retired = await curate(dir, { max: input.max, staleDays: input.staleDays, keep: input.name }, now)
  return { status: existing ? "updated" : "saved", retired }
}

export async function remove(dir: string, name: string, now = Date.now()) {
  const index = await readIndex(dir)
  if (!index[name]) return false
  await archive(dir, name, now)
  delete index[name]
  await writeIndex(dir, index)
  return true
}

/** Notes that a learned skill was loaded; the curator keeps skills that are used. */
export async function recordUse(dir: string, name: string, now = Date.now()) {
  const index = await readIndex(dir)
  const entry = index[name]
  if (!entry) return
  index[name] = { ...entry, uses: entry.uses + 1, lastUsed: now }
  await writeIndex(dir, index)
}

/** Retires stale skills, then the least used until at most `max` remain. Returns the retired names. */
export async function curate(
  dir: string,
  opts: { max?: number; staleDays?: number; keep?: string } = {},
  now = Date.now(),
) {
  const index = await readIndex(dir)
  const max = opts.max ?? DEFAULT_MAX
  const stale = (opts.staleDays ?? DEFAULT_STALE_DAYS) * DAY
  const lastActive = (entry: Entry) => entry.lastUsed ?? entry.updated
  const retired: string[] = []
  for (const [name, entry] of Object.entries(index)) {
    if (name !== opts.keep && now - lastActive(entry) > stale) retired.push(name)
  }
  const remaining = Object.entries(index)
    .filter(([name]) => !retired.includes(name) && name !== opts.keep)
    .toSorted(([, a], [, b]) => a.uses - b.uses || lastActive(a) - lastActive(b))
  const room = Math.max(0, max - (opts.keep && index[opts.keep] ? 1 : 0))
  while (remaining.length > room) retired.push(remaining.shift()![0])
  for (const name of retired) {
    await archive(dir, name, now)
    delete index[name]
  }
  if (retired.length > 0) await writeIndex(dir, index)
  return retired
}

export * as LearnedSkills from "./learned"
