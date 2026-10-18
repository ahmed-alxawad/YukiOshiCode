// Repo map (repo_map.enabled, off by default): a compact, ranked list of the repo's key files and their
// definitions, in the spirit of Aider's repo map (idea only, no code copied). Files come from git (so
// .gitignore is respected), definitions from per-language patterns, and files are ranked by how many other
// files mention their symbols (a small deterministic PageRank). Local only: no network, no model calls.

import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"

export const DEFAULT_TOKENS = 1024
export const MAX_FILES = 2000
const MAX_BYTES = 200_000

export interface Def {
  name: string
  kind: string
}

const PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(type)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/,
  ],
  py: [/^\s*(?:async\s+)?(def)\s+([A-Za-z_]\w*)/, /^\s*(class)\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?()([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/],
  java: [/^\s*(?:public|private|protected|static|final|abstract|\s)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/],
}
const EXT: Record<string, string> = {
  ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "java",
}

export function definitions(file: string, text: string): Def[] {
  const pats = PATTERNS[EXT[path.extname(file).toLowerCase()] ?? ""]
  if (!pats) return []
  const out: Def[] = []
  const seen = new Set<string>()
  for (const line of text.split("\n")) {
    if (line.length > 300) continue
    for (const re of pats) {
      const m = re.exec(line)
      if (!m) continue
      // go's type pattern captures (name, kind); the others capture (kind, name)
      const [a, b] = [m[1] ?? "", m[2] ?? ""]
      const [kind, name] = re === PATTERNS.go?.[1] ? [b, a] : [a || "func", b]
      if (name.length < 3 || seen.has(name)) break
      seen.add(name)
      out.push({ name, kind })
      break
    }
  }
  return out
}

export function listFiles(root: string, max = MAX_FILES): string[] {
  let out: string
  try {
    const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (r.error || r.status !== 0) return []
    out = r.stdout.toString()
  } catch {
    return []
  }
  return out
    .split("\0")
    .filter((f) => f && EXT[path.extname(f).toLowerCase()])
    .sort()
    .slice(0, max)
}

const WORD = /[A-Za-z_$][\w$]{2,}/g

/** Rank files by PageRank over "file A mentions a symbol defined in file B". Ties break by path. */
export function rank(files: { file: string; defs: Def[]; words: Set<string> }[]) {
  const definers = new Map<string, string[]>()
  for (const f of files) for (const d of f.defs) definers.set(d.name, [...(definers.get(d.name) ?? []), f.file])
  const out = new Map<string, Map<string, number>>()
  for (const f of files) {
    const edges = new Map<string, number>()
    for (const w of f.words) for (const target of definers.get(w) ?? []) if (target !== f.file) edges.set(target, (edges.get(target) ?? 0) + 1)
    out.set(f.file, edges)
  }
  const n = files.length
  let score = new Map(files.map((f) => [f.file, 1 / n]))
  for (let i = 0; i < 20; i++) {
    const next = new Map(files.map((f) => [f.file, 0.15 / n]))
    for (const f of files) {
      const edges = out.get(f.file)!
      let total = 0
      for (const w of edges.values()) total += w
      if (total === 0) {
        for (const g of files) next.set(g.file, next.get(g.file)! + (0.85 * score.get(f.file)!) / n)
        continue
      }
      for (const [t, w] of [...edges].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
        next.set(t, next.get(t)! + (0.85 * score.get(f.file)! * w) / total)
    }
    score = next
  }
  return files.map((f) => f.file).sort((a, b) => score.get(b)! - score.get(a)! || (a < b ? -1 : 1))
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export function render(ranked: { file: string; defs: Def[] }[], tokens: number) {
  const header = "Repo map (key files and definitions, most referenced first; may be stale, re-read files before editing):\n"
  let out = header
  for (const f of ranked) {
    if (f.defs.length === 0) continue
    const block = `${f.file}:\n${f.defs.map((d) => `  ${d.kind} ${d.name}`).join("\n")}\n`
    if (estimateTokens(out + block) <= tokens) {
      out += block
      continue
    }
    // keep going: a smaller later file may still fit, but try a truncated version of this one first
    const lines = block.split("\n")
    let part = ""
    for (const line of lines.slice(0, -1)) {
      if (estimateTokens(out + part + line + "\n") > tokens) break
      part += line + "\n"
    }
    if (part.includes("\n  ")) out += part
    break
  }
  return out === header ? "" : out
}

const cache = new Map<string, { sig: string; text: string }>()

export function build(root: string, tokens = DEFAULT_TOKENS, maxFiles = MAX_FILES): string {
  const files = listFiles(root, maxFiles)
  const stats = files.flatMap((f) => {
    try {
      const st = fs.statSync(path.join(root, f))
      return st.isFile() && st.size <= MAX_BYTES ? [{ f, sig: `${f}:${st.size}:${st.mtimeMs}` }] : []
    } catch {
      return []
    }
  })
  const sig = `${tokens}|${stats.map((s) => s.sig).join("|")}`
  const hit = cache.get(root)
  if (hit?.sig === sig) return hit.text
  const infos = stats.map(({ f }) => {
    const text = fs.readFileSync(path.join(root, f), "utf8")
    return { file: f, defs: definitions(f, text), words: new Set(text.match(WORD) ?? []) }
  })
  const order = rank(infos)
  const byFile = new Map(infos.map((i) => [i.file, i]))
  const text = render(order.map((f) => byFile.get(f)!), tokens)
  cache.set(root, { sig, text })
  return text
}

/** The system-prompt text for a config, or undefined when the map is off. */
export function systemText(root: string, cfg: { enabled?: boolean; tokens?: number } | undefined) {
  if (cfg?.enabled !== true) return undefined
  const text = build(root, cfg.tokens && cfg.tokens > 0 ? cfg.tokens : DEFAULT_TOKENS)
  return text || undefined
}

export * as SessionRepoMap from "./repo-map"
