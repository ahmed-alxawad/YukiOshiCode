import { AcpCommand } from "./cmd/acp"
import { AttachCommand } from "./cmd/attach"
import { AgentCommand } from "./cmd/agent"
import { ConsoleCommand } from "./cmd/account"
import { CheckpointCommand } from "./cmd/checkpoint"
import { DbCommand } from "./cmd/db"
import { DebugCommand } from "./cmd/debug"
import { ExportCommand } from "./cmd/export"
import { GenerateCommand } from "./cmd/generate"
import { ImportCommand } from "./cmd/import"
import { McpCommand } from "./cmd/mcp"
import { ModelsCommand } from "./cmd/models"
import { PluginCommand } from "./cmd/plug"
import { PrCommand } from "./cmd/pr"
import { ProvidersCommand } from "./cmd/providers"
import { RunCommand } from "./cmd/run"
import { ScheduleCommand } from "./cmd/schedule"
import { ServeCommand } from "./cmd/serve"
import { SessionCommand } from "./cmd/session"
import { SkillCommand } from "./cmd/skill"
import { StatsCommand } from "./cmd/stats"
import { TasksCommand } from "./cmd/tasks"
import { TuiThreadCommand } from "./cmd/tui"
import { TrustCommand } from "./cmd/trust"
import { UninstallCommand } from "./cmd/uninstall"
import { UpgradeCommand } from "./cmd/upgrade"
import { WorktreeCommand } from "./cmd/worktree"

const commands = {
  acp: AcpCommand,
  agent: AgentCommand,
  attach: AttachCommand,
  console: ConsoleCommand,
  checkpoint: CheckpointCommand,
  db: DbCommand,
  debug: DebugCommand,
  export: ExportCommand,
  generate: GenerateCommand,
  import: ImportCommand,
  mcp: McpCommand,
  models: ModelsCommand,
  plugin: PluginCommand,
  pr: PrCommand,
  providers: ProvidersCommand,
  run: RunCommand,
  schedule: ScheduleCommand,
  serve: ServeCommand,
  session: SessionCommand,
  skill: SkillCommand,
  stats: StatsCommand,
  tasks: TasksCommand,
  tui: TuiThreadCommand,
  trust: TrustCommand,
  uninstall: UninstallCommand,
  upgrade: UpgradeCommand,
  worktree: WorktreeCommand,
} as const

export type CommandName = keyof typeof commands

export function loadCommand(name: CommandName) {
  return commands[name]
}
