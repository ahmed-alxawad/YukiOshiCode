import path from "node:path"
import type { WorkspaceFile, WorkspaceSelection } from "./contracts"

export interface FileEntry {
  name: string
  isFile(): boolean
  isDirectory(): boolean
}

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>
  readdir(path: string): Promise<FileEntry[]>
  readFile(path: string, encoding: "utf8"): Promise<string>
}

export interface WorkspacePicker {
  pickDirectory(): Promise<string | null>
}

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export class WorkspaceService {
  #root: string | null = null

  constructor(
    private readonly fs: WorkspaceFileSystem,
    private readonly picker: WorkspacePicker,
  ) {}

  async select(): Promise<WorkspaceSelection | null> {
    const selected = await this.picker.pickDirectory()
    if (selected === null) return null
    const root = await this.fs.realpath(path.resolve(selected))
    this.#root = root
    return { path: root, name: path.basename(root) }
  }

  async listFiles(): Promise<WorkspaceFile[]> {
    const root = this.requireRoot()
    const entries = await this.fs.readdir(root)
    return entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry): WorkspaceFile => ({ path: entry.name, kind: entry.isDirectory() ? "directory" : "file" }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  async readFile(relativePath: string): Promise<string> {
    const root = this.requireRoot()
    if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed")
    const lexicalPath = path.resolve(root, relativePath)
    if (!isWithin(root, lexicalPath)) throw new Error("Path escapes the selected workspace")
    const canonicalPath = await this.fs.realpath(lexicalPath)
    if (!isWithin(root, canonicalPath)) throw new Error("Path escapes the selected workspace")
    return this.fs.readFile(canonicalPath, "utf8")
  }

  private requireRoot(): string {
    if (this.#root === null) throw new Error("Select a workspace first")
    return this.#root
  }
}
