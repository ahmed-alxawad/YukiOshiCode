export type GraphSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method"
  | "module"
  | "enum"
  | "other"

export type GraphRelation =
  | "imports"
  | "imported_by"
  | "calls"
  | "called_by"
  | "tests"
  | "tested_by"
  | "contains"
  | "related"

export interface GraphSymbol {
  readonly name: string
  readonly kind: GraphSymbolKind
  /** Workspace-relative path, using forward slashes. */
  readonly path: string
  readonly line?: number
  readonly exported?: boolean
}

export interface GraphNeighbor {
  readonly path: string
  readonly relation: GraphRelation
  readonly distance: number
  readonly via?: string
}

export interface ImportantFile {
  readonly path: string
  /** Relative connectedness score; this is a retrieval signal, not truth. */
  readonly score: number
}

export interface NeighborQuery {
  readonly path: string
  readonly depth?: number
  readonly limit?: number
}

export interface SymbolQuery {
  readonly text: string
  readonly limit?: number
}

export type GraphProviderName = "graphify" | "local" | "none"

export interface CodeGraphStatus {
  readonly provider: GraphProviderName
  readonly available: boolean
  readonly fresh: boolean
  readonly builtAt?: string
  readonly nodeCount: number
  readonly edgeCount: number
  readonly message: string
  readonly degraded: boolean
  readonly notInstalled?: boolean
}

/** Structural answers are retrieval signals; callers must re-read files before editing. */
export interface CodeGraphProvider {
  readonly name: GraphProviderName
  status(): Promise<CodeGraphStatus>
  refresh(signal?: AbortSignal): Promise<CodeGraphStatus>
  findSymbols(query: SymbolQuery): Promise<GraphSymbol[]>
  neighbors(query: NeighborQuery): Promise<GraphNeighbor[]>
  path(fromPath: string, toPath: string): Promise<string[] | undefined>
  importantFiles(limit: number): Promise<ImportantFile[]>
}
