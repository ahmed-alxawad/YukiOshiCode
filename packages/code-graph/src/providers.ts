import { spawn } from "node:child_process"
import { access, readFile, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type {
  CodeGraphProvider,
  CodeGraphStatus,
  GraphNeighbor,
  GraphRelation,
  GraphSymbol,
  GraphSymbolKind,
  ImportantFile,
  NeighborQuery,
  SymbolQuery,
} from "./contracts"
import { GraphStore } from "./graph-store"

export interface LocalGraphFile {
  readonly path: string
  readonly imports: readonly string[]
  readonly symbols: readonly {
    readonly name: string
    readonly kind: GraphSymbolKind
    readonly line: number
    readonly exported: boolean
  }[]
  readonly tests?: readonly string[]
}

export interface LocalGraphSource {
  readonly files: readonly LocalGraphFile[]
  readonly builtAt: string
}

export interface GraphifyConfig {
  readonly workspaceRoot: string
  readonly graphPath?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly timeoutMs?: number
  readonly maxGraphBytes?: number
}

function emptyStatus(provider: CodeGraphStatus["provider"], message: string): CodeGraphStatus {
  return { provider, available: false, fresh: false, nodeCount: 0, edgeCount: 0, message, degraded: false }
}

export class NullCodeGraphProvider implements CodeGraphProvider {
  readonly name = "none" as const
  constructor(private readonly reason = "Code graph is disabled; using text search only.") {}
  status() {
    return Promise.resolve(emptyStatus("none", this.reason))
  }
  refresh() {
    return this.status()
  }
  findSymbols(_query: SymbolQuery) {
    return Promise.resolve([])
  }
  neighbors(_query: NeighborQuery) {
    return Promise.resolve([])
  }
  path(_from: string, _to: string) {
    return Promise.resolve(undefined)
  }
  importantFiles(_limit: number) {
    return Promise.resolve([])
  }
}

export class LocalSymbolGraphProvider implements CodeGraphProvider {
  readonly name = "local" as const
  private store = new GraphStore()
  private builtAt: string | undefined
  private stale = false

  constructor(private readonly loadSource?: (signal?: AbortSignal) => Promise<LocalGraphSource>) {}

  load(source: LocalGraphSource) {
    const store = new GraphStore()
    for (const file of source.files) {
      store.addFile(file.path)
      for (const target of file.imports) store.addEdge(file.path, target, "imports")
      for (const target of file.tests ?? []) store.addEdge(file.path, target, "tests")
      for (const symbol of file.symbols) store.addSymbol({ ...symbol, path: file.path })
    }
    this.store = store
    this.builtAt = source.builtAt
    this.stale = false
  }

  markStale() {
    this.stale = true
  }

  status() {
    const available = this.builtAt !== undefined
    return Promise.resolve({
      provider: "local" as const,
      available,
      fresh: available && !this.stale,
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      nodeCount: this.store.nodeCount,
      edgeCount: this.store.edges,
      message: available
        ? `Local symbol graph: ${this.store.nodeCount} files, ${this.store.edges} links.`
        : "Local symbol graph has not been built yet.",
      degraded: false,
    })
  }

  async refresh(signal?: AbortSignal) {
    if (this.loadSource) this.load(await this.loadSource(signal))
    return this.status()
  }
  findSymbols(query: SymbolQuery) {
    return Promise.resolve(this.store.findSymbols(query.text, query.limit ?? 20))
  }
  neighbors(query: NeighborQuery) {
    return Promise.resolve(this.store.neighbors(query.path, query.depth ?? 1, query.limit ?? 20))
  }
  path(from: string, to: string) {
    return Promise.resolve(this.store.shortestPath(from, to))
  }
  importantFiles(limit: number) {
    return Promise.resolve(this.store.importantFiles(limit))
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function normalizePath(value: unknown, root: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  let path = value.replaceAll("\\", "/")
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "")
  if (path.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) path = path.slice(normalizedRoot.length + 1)
  path = path.replace(/^\.\//, "")
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) return undefined
  return path
}

function graphKind(value: unknown): GraphSymbolKind {
  const text = typeof value === "string" ? value.toLowerCase() : ""
  if (text.includes("class")) return "class"
  if (text.includes("interface")) return "interface"
  if (text.includes("method")) return "method"
  if (text.includes("func") || text.includes("def")) return "function"
  if (text.includes("enum")) return "enum"
  if (text.includes("type")) return "type"
  if (text.includes("var") || text.includes("const")) return "variable"
  if (text.includes("module") || text.includes("file")) return "module"
  return "other"
}

const relationNames: Record<string, GraphRelation> = {
  imports: "imports",
  import: "imports",
  imports_from: "imports",
  depends_on: "imports",
  uses: "imports",
  calls: "calls",
  call: "calls",
  invokes: "calls",
  tests: "tests",
  tested_by: "tested_by",
  contains: "contains",
  defines: "contains",
  method: "contains",
}

export function mapGraphifyGraph(document: unknown, workspaceRoot: string) {
  const root = record(document)
  const graph = record(root.graph)
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : Array.isArray(root.nodes) ? root.nodes : []
  const edges = Array.isArray(graph.links)
    ? graph.links
    : Array.isArray(graph.edges)
      ? graph.edges
      : Array.isArray(root.links)
        ? root.links
        : Array.isArray(root.edges)
          ? root.edges
          : []
  const store = new GraphStore()
  const byId = new Map<string, { path?: string; name: string; kind: GraphSymbolKind; line?: number; isFile: boolean }>()
  for (const raw of nodes) {
    const node = record(raw)
    const id = typeof node.id === "string" || typeof node.id === "number" ? String(node.id) : undefined
    if (!id) continue
    const path = normalizePath(node.source_file ?? node.file ?? node.path ?? node.filepath, workspaceRoot)
    const location = typeof node.source_location === "string" ? /L(\d+)/.exec(node.source_location)?.[1] : undefined
    const line = typeof node.line === "number" ? node.line : location ? Number(location) : undefined
    const name = typeof node.label === "string" ? node.label : typeof node.name === "string" ? node.name : id
    const kind = graphKind(node.kind ?? node.type ?? node.node_type)
    const isFile =
      kind === "module" || Boolean(path && (name === path || name.endsWith(path.split("/").pop() ?? "\0")) && !line)
    byId.set(id, { name, kind, ...(path ? { path } : {}), ...(line ? { line } : {}), isFile })
    if (path) {
      store.addFile(path)
      if (!isFile) store.addSymbol({ name, kind, path, ...(line ? { line } : {}) })
    }
  }
  for (const raw of edges) {
    const edge = record(raw)
    const source = byId.get(String(edge.source ?? edge.from ?? ""))
    const target = byId.get(String(edge.target ?? edge.to ?? ""))
    if (!source?.path || !target?.path || source.path === target.path) continue
    store.addEdge(
      source.path,
      target.path,
      relationNames[String(edge.relation ?? edge.type ?? edge.label ?? "").toLowerCase()] ?? "related",
    )
  }
  return store
}

async function graphHealth(config: GraphifyConfig) {
  const graphPath = config.graphPath ?? "graphify-out/graph.json"
  const absolute = resolve(config.workspaceRoot, graphPath)
  const rel = relative(config.workspaceRoot, absolute)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    return { absolute, exists: false, problem: "graphPath must be inside the workspace." }
  try {
    await access(absolute, constants.R_OK)
    const info = await stat(absolute)
    const max = config.maxGraphBytes ?? 64 * 1024 * 1024
    if (!info.isFile()) return { absolute, exists: false }
    if (info.size > max)
      return {
        absolute,
        exists: true,
        modifiedMs: info.mtimeMs,
        problem: `The graph file is larger than ${Math.round(max / 1024 / 1024)} MiB.`,
      }
    return { absolute, exists: true, modifiedMs: info.mtimeMs }
  } catch {
    return { absolute, exists: false }
  }
}

async function runGraphify(config: GraphifyConfig, signal?: AbortSignal) {
  if (!config.command) return { ok: false, message: "No Graphify command is configured." }
  return new Promise<{ ok: boolean; message: string }>((resolveResult) => {
    const child = spawn(config.command!, [...(config.args ?? ["."])], {
      cwd: config.workspaceRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill()
      resolveResult({
        ok: false,
        message: `Graphify timed out after ${Math.round((config.timeoutMs ?? 30_000) / 1000)}s.`,
      })
    }, config.timeoutMs ?? 30_000)
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    child.stderr.on("data", (data) => {
      stderr += String(data)
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      resolveResult({ ok: false, message: `Graphify could not start: ${error.message}` })
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      if (code === 0) resolveResult({ ok: true, message: "Graphify rebuilt the graph." })
      else
        resolveResult({
          ok: false,
          message: `Graphify exited with code ${code}: ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}`,
        })
    })
  })
}

export class GraphifyProvider implements CodeGraphProvider {
  readonly name = "graphify" as const
  private store: GraphStore | undefined
  private loadedMtime: number | undefined
  private newestWorkspaceChangeMs = 0
  private lastProblem: string | undefined
  constructor(private readonly config: GraphifyConfig) {}

  noteWorkspaceChange(mtimeMs: number) {
    this.newestWorkspaceChangeMs = Math.max(this.newestWorkspaceChangeMs, mtimeMs)
  }

  async status() {
    await this.ensureLoaded()
    const available = this.store !== undefined
    const fresh = available && this.loadedMtime !== undefined && this.loadedMtime >= this.newestWorkspaceChangeMs
    return {
      provider: "graphify" as const,
      available,
      fresh,
      ...(this.loadedMtime ? { builtAt: new Date(this.loadedMtime).toISOString() } : {}),
      nodeCount: this.store?.nodeCount ?? 0,
      edgeCount: this.store?.edges ?? 0,
      message: available
        ? `Graphify graph: ${this.store!.nodeCount} files, ${this.store!.edges} links${fresh ? "" : " (older than recent changes)"}.`
        : (this.lastProblem ?? `No Graphify graph found at ${this.config.graphPath ?? "graphify-out/graph.json"}.`),
      degraded: false,
      ...(!available && !this.lastProblem ? { notInstalled: true } : {}),
    }
  }

  async refresh(signal?: AbortSignal) {
    if (this.config.command) {
      const result = await runGraphify(this.config, signal)
      if (!result.ok) this.lastProblem = result.message
    }
    this.store = undefined
    this.loadedMtime = undefined
    await this.ensureLoaded(true)
    return this.status()
  }

  private async ensureLoaded(force = false) {
    if (this.store && !force) return
    const health = await graphHealth(this.config)
    if (!health.exists || health.problem) {
      this.store = undefined
      this.loadedMtime = undefined
      if (health.problem) this.lastProblem = health.problem
      return
    }
    if (!force && this.loadedMtime === health.modifiedMs) return
    try {
      this.store = mapGraphifyGraph(JSON.parse(await readFile(health.absolute, "utf8")), this.config.workspaceRoot)
      this.loadedMtime = health.modifiedMs
      this.lastProblem = this.store.nodeCount === 0 ? "The Graphify graph contained no usable nodes." : undefined
      if (this.store.nodeCount === 0) this.store = undefined
    } catch (error) {
      this.store = undefined
      this.loadedMtime = undefined
      this.lastProblem = `The Graphify graph could not be read: ${(error as Error).message}`
    }
  }

  findSymbols(query: SymbolQuery) {
    return Promise.resolve(this.store?.findSymbols(query.text, query.limit ?? 20) ?? [])
  }
  neighbors(query: NeighborQuery) {
    return Promise.resolve(this.store?.neighbors(query.path, query.depth ?? 1, query.limit ?? 20) ?? [])
  }
  path(from: string, to: string) {
    return Promise.resolve(this.store?.shortestPath(from, to))
  }
  importantFiles(limit: number) {
    return Promise.resolve(this.store?.importantFiles(limit) ?? [])
  }
}

export class FallbackCodeGraphProvider implements CodeGraphProvider {
  private usingFallback = false
  private missing = false
  private reason = ""
  constructor(
    private readonly primary: CodeGraphProvider,
    private readonly fallback: CodeGraphProvider,
    private readonly primaryRequired = true,
  ) {}
  get name() {
    return this.usingFallback ? this.fallback.name : this.primary.name
  }
  async status() {
    const active = await this.active()
    const status = await active.status()
    if (!this.usingFallback || (!this.primaryRequired && this.missing)) return status
    return {
      ...status,
      degraded: true,
      message: `${this.reason} Using ${this.fallback.name} graph instead. ${status.message}`,
    }
  }
  async refresh(signal?: AbortSignal) {
    try {
      await this.primary.refresh(signal)
    } catch (error) {
      this.reason = `${this.primary.name} failed: ${(error as Error).message}.`
      this.missing = false
    }
    await this.fallback.refresh(signal).catch(() => undefined)
    return this.status()
  }
  async findSymbols(query: SymbolQuery) {
    return (await this.active()).findSymbols(query)
  }
  async neighbors(query: NeighborQuery) {
    return (await this.active()).neighbors(query)
  }
  async path(from: string, to: string) {
    return (await this.active()).path(from, to)
  }
  async importantFiles(limit: number) {
    return (await this.active()).importantFiles(limit)
  }
  private async active() {
    try {
      const status = await this.primary.status()
      if (status.available) {
        this.usingFallback = false
        return this.primary
      }
      this.reason = status.message
      this.missing = status.notInstalled === true
    } catch (error) {
      this.reason = `${this.primary.name} failed: ${(error as Error).message}.`
      this.missing = false
    }
    this.usingFallback = true
    return this.fallback
  }
}
