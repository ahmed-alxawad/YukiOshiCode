import path from "node:path"

export type FileChange = {
  file?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type FileChangeEntry = {
  path: string
  additions: number
  deletions: number
  status?: FileChange["status"]
}

export type FileChangeSummary = {
  files: number
  additions: number
  deletions: number
  entries: FileChangeEntry[]
  remaining: number
}

function displayPath(file: string, root?: string) {
  const normalized = file.replaceAll("\\", "/")
  if (!root || !path.isAbsolute(file)) return normalized
  return path.relative(root, file).replaceAll("\\", "/") || path.basename(file)
}

export function summarizeFileChanges(changes: readonly FileChange[], root?: string): FileChangeSummary {
  const entries = changes
    .filter((change): change is FileChange & { file: string } => Boolean(change.file))
    .map((change) => ({
      path: displayPath(change.file, root),
      additions: change.additions,
      deletions: change.deletions,
      status: change.status,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const visible = entries.slice(0, 8)
  return {
    files: entries.length,
    additions: entries.reduce((total, entry) => total + entry.additions, 0),
    deletions: entries.reduce((total, entry) => total + entry.deletions, 0),
    entries: visible,
    remaining: Math.max(0, entries.length - visible.length),
  }
}

export function formatFileChanges(changes: readonly FileChange[], root?: string) {
  const summary = summarizeFileChanges(changes, root)
  if (summary.files === 0) return ""

  const lines = [
    `Changed ${summary.files} file${summary.files === 1 ? "" : "s"}  +${summary.additions} −${summary.deletions}`,
  ]
  for (const entry of summary.entries) {
    const label = entry.status === "added" ? " (new)" : entry.status === "deleted" ? " (deleted)" : ""
    const additions = entry.additions > 0 ? `+${entry.additions}` : ""
    const deletions = entry.deletions > 0 ? `−${entry.deletions}` : ""
    const counts = [additions, deletions].filter(Boolean).join(" ")
    lines.push(`  ${entry.path}${label}${counts ? `  ${counts}` : ""}`)
  }
  if (summary.remaining > 0) lines.push(`  … and ${summary.remaining} more`)
  return lines.join("\n")
}
