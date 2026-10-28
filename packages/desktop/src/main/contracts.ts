export const desktopChannels = {
  selectWorkspace: "desktop:workspace:select",
  listWorkspaceFiles: "desktop:workspace:list-files",
  readWorkspaceFile: "desktop:workspace:read-file",
  listChanges: "desktop:agent:list-changes",
  readDiff: "desktop:agent:read-diff",
  startTask: "desktop:agent:start-task",
  cancelTask: "desktop:agent:cancel-task",
} as const

export type DesktopChannel = (typeof desktopChannels)[keyof typeof desktopChannels]

export interface WorkspaceSelection {
  path: string
  name: string
}

export interface WorkspaceFile {
  path: string
  kind: "file" | "directory"
}

export interface ChangeSummary {
  path: string
  additions: number
  deletions: number
  status: string
}

export interface ReadDiffInput {
  source: "git" | "session"
  path?: string
}

export interface StartTaskInput {
  prompt: string
}

export interface StartedTask {
  taskId: string
}

export interface CancelTaskInput {
  taskId: string
}

export interface DesktopBridge {
  selectWorkspace(): Promise<WorkspaceSelection | null>
  listWorkspaceFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<string>
  listChanges(): Promise<ChangeSummary[]>
  readDiff(input: ReadDiffInput): Promise<string>
  startTask(input: StartTaskInput): Promise<StartedTask>
  cancelTask(input: CancelTaskInput): Promise<void>
}
