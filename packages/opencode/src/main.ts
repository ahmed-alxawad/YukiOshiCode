import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { FormatError, FormatUnexpectedError, debugRequested } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { TasksCommand } from "./cli/cmd/tasks"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { TrustCommand } from "./cli/cmd/trust"
import { CheckpointCommand } from "./cli/cmd/checkpoint"
import { ScheduleCommand } from "./cli/cmd/schedule"
import { SkillCommand } from "./cli/cmd/skill"
import { WorktreeCommand } from "./cli/cmd/worktree"
import { ChildRegistry } from "@yukioshi/core/child-registry"

const args = hideBin(process.argv)
const loadCommand = (name: import("./cli/lazy-commands").CommandName) =>
  import("./cli/lazy-commands").then((module) => module.loadCommand(name))

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("yukioshi ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Ctrl-C, SIGTERM and SIGHUP must not leave shell commands, hooks, MCP or delegate agents running.
ChildRegistry.stopOnSignals(["SIGINT", "SIGTERM", "SIGHUP"])

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("yukioshi")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.YUKIOSHI_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.YUKIOSHI_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.YUKIOSHI_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.YUKIOSHI = "1"
    process.env.YUKIOSHI_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(
    lazyCommand({
      command: "acp",
      describe: "start ACP (Agent Client Protocol) server",
      load: () => loadCommand("acp"),
    }),
  )
  .command(
    lazyCommand({
      command: "mcp",
      describe: "manage MCP (Model Context Protocol) servers",
      load: () => loadCommand("mcp"),
    }),
  )
  .command(
    lazyCommand({
      command: "$0 [project]",
      describe: "start yukioshi tui",
      load: () => loadCommand("tui"),
    }),
  )
  .command(
    lazyCommand({
      command: "attach <url>",
      describe: "attach to a running yukioshi server",
      load: () => loadCommand("attach"),
    }),
  )
  .command(
    lazyCommand({
      command: "run [message..]",
      describe: "run yukioshi with a message",
      load: () => loadCommand("run"),
    }),
  )
  .command(
    lazyCommand({ command: "generate", load: () => loadCommand("generate") }),
  )
  .command(
    lazyCommand({
      command: "debug",
      describe: "debugging and troubleshooting tools",
      load: () => loadCommand("debug"),
    }),
  )
  .command(
    lazyCommand({
      command: "console",
      describe: false,
      load: () => loadCommand("console"),
    }),
  )
  .command(
    lazyCommand({
      command: "providers",
      aliases: ["auth"],
      describe: "manage AI providers and credentials",
      load: () => loadCommand("providers"),
    }),
  )
  .command(
    lazyCommand({
      command: "agent",
      describe: "manage agents",
      load: () => loadCommand("agent"),
    }),
  )
  .command(
    lazyCommand({
      command: "upgrade [target]",
      describe: "upgrade yukioshi to the latest or a specific version",
      load: () => loadCommand("upgrade"),
    }),
  )
  .command(
    lazyCommand({
      command: "uninstall",
      describe: "uninstall yukioshi and remove all related files",
      load: () => loadCommand("uninstall"),
    }),
  )
  .command(
    lazyCommand({
      command: "serve",
      describe: "starts a headless yukioshi server",
      load: () => loadCommand("serve"),
    }),
  )
  .command(
    lazyCommand({
      command: "models [provider]",
      describe: "list all available models",
      load: () => loadCommand("models"),
    }),
  )
  .command(
    lazyCommand({
      command: "stats",
      describe: "show token usage and cost statistics",
      load: () => loadCommand("stats"),
    }),
  )
  .command(
    lazyCommand({
      command: "tasks",
      describe:
        "list the background jobs and background subagents of a session, or with --all every running session (read-only)",
      load: () => loadCommand("tasks"),
    }),
  )
  .command(
    lazyCommand({
      command: "export [sessionID]",
      describe: "export session data as JSON",
      load: () => loadCommand("export"),
    }),
  )
  .command(
    lazyCommand({
      command: "import [file]",
      describe: "import a session: an exported JSON file, a share URL, or a Claude Code or Codex conversation (.jsonl)",
      load: () => loadCommand("import"),
    }),
  )
  .command(
    lazyCommand({
      command: "pr <number>",
      describe: "fetch and checkout a GitHub PR branch, then run yukioshi",
      load: () => loadCommand("pr"),
    }),
  )
  .command(
    lazyCommand({
      command: "session",
      describe: "manage sessions",
      load: () => loadCommand("session"),
    }),
  )
  .command(
    lazyCommand({
      command: "plugin [action] [target] [extra]",
      aliases: ["plug"],
      describe: "install, list, or remove plugins (npm packages, or Claude Code plugins/marketplaces from git)",
      load: () => loadCommand("plugin"),
    }),
  )
  .command(
    lazyCommand({
      command: "trust [directory]",
      describe: "allow this project to run its own hooks, plugins, and commands",
      load: () => loadCommand("trust"),
    }),
  )
  .command(
    lazyCommand({
      command: "checkpoint <action> [id]",
      describe: "list, inspect, restore, or prune durable git checkpoints",
      load: () => loadCommand("checkpoint"),
    }),
  )
  .command(
    lazyCommand({
      command: "schedule",
      describe: "manage scheduled tasks and recurring runs",
      load: () => loadCommand("schedule"),
    }),
  )
  .command(
    lazyCommand({
      command: "skill <action> [target]",
      describe: "install, list, or remove skills from git repositories",
      load: () => loadCommand("skill"),
    }),
  )
  .command(
    lazyCommand({
      command: "worktree <action> [name]",
      describe: "create, list, locate, or remove git worktrees for parallel sessions",
      load: () => loadCommand("worktree"),
    }),
  )
  .command(
    lazyCommand({
      command: "db",
      describe: "database tools",
      load: () => loadCommand("db"),
    }),
  )
  .command(
    lazyCommand({
      command: "doctor",
      describe: "check installation, providers, tools, sandbox, clipboard, and state",
      load: () => loadCommand("doctor"),
    }),
  )
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    // Say what was wrong after the help text, so the reason is the last thing on screen.
    if (msg)
      process.stderr.write(
        EOL +
          UI.Style.TEXT_DANGER_BOLD +
          "Error: " +
          UI.Style.TEXT_NORMAL +
          msg +
          EOL +
          "Run the command again with --help to see its usage." +
          EOL,
      )
    process.exit(1)
  })
  .strict()

try {
  // yargs' built-in completion command has no help of its own and would print the main help with an error.
  if (args[0] === "completion" && (args.includes("-h") || args.includes("--help"))) {
    process.stdout.write(
      [
        "yukioshi completion",
        "",
        "Print a shell completion script for bash or zsh. Add it to your shell's startup file, for example:",
        "  yukioshi completion >> ~/.bashrc",
        "  yukioshi completion >> ~/.zshrc",
        "",
      ].join(EOL),
    )
  } else if (args.includes("-h") || args.includes("--help")) {
    // Async command builders make yargs write help directly to stdout instead
    // of passing it through the callback. Keep the CLI's established stderr
    // help contract for both paths.
    const helpSuffix = args.length === 1 ? EOL : ""
    console.log = (...parts: unknown[]) => {
      process.stderr.write(parts.join(" ") + helpSuffix)
    }
    await cli.parseAsync(args)
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error(FormatUnexpectedError(e, debugRequested(args)))
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  // Output to a pipe is written asynchronously, and exiting at once cut it off at the pipe buffer
  // (64 KB). When stdout or stderr is not a terminal, give the writes a moment to drain first.
  if (!process.stdout.isTTY || !process.stderr.isTTY) await new Promise((resolve) => setTimeout(resolve, 200))
  process.exit()
}
