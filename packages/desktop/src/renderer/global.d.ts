export {}

declare global {
  interface Window {
    kothoraDesktop: KothoraDesktopBridge
  }
}

export interface WorkspaceFile {
  path: string
  kind: "file" | "directory"
}

export interface WorkspaceSelection {
  path: string
  name: string
}

export interface ChangedFile {
  path: string
  additions: number
  deletions: number
  status: string
}

export interface TaskRun {
  id: string
  status: "running" | "complete" | "cancelled" | "failed"
}

export interface KothoraDesktopBridge {
  selectWorkspace(): Promise<WorkspaceSelection | null>
  listWorkspaceFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<string>
  listChanges(): Promise<ChangedFile[]>
  readDiff(input: { source: "git" | "session"; path?: string }): Promise<string>
  startTask(input: { prompt: string }): Promise<{ taskId: string }>
  getTask(input: { taskId: string }): Promise<{ taskId: string; status: TaskRun["status"] }>
  cancelTask(input: { taskId: string }): Promise<void>
}
