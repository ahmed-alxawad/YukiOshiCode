import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { FormatError, FormatUnexpectedError, debugRequested } from "./cli/error"
import { EOL } from "os"
import { Heap } from "./cli/heap"
import { ChildRegistry } from "@yukioshi/core/child-registry"
import { lazyCommand } from "./cli/lazy-command"

const args = hideBin(process.argv)

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
      load: () => import("./cli/cmd/acp").then((m) => m.AcpCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "mcp",
      describe: "manage MCP (Model Context Protocol) servers",
      load: () => import("./cli/cmd/mcp").then((m) => m.McpCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "$0 [project]",
      describe: "start yukioshi tui",
      load: () => import("./cli/cmd/tui").then((m) => m.TuiThreadCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "attach <url>",
      describe: "attach to a running yukioshi server",
      load: () => import("./cli/cmd/attach").then((m) => m.AttachCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "run [message..]",
      describe: "run yukioshi with a message",
      load: () => import("./cli/cmd/run").then((m) => m.RunCommand),
    }),
  )
  .command(
    lazyCommand({ command: "generate", load: () => import("./cli/cmd/generate").then((m) => m.GenerateCommand) }),
  )
  .command(
    lazyCommand({
      command: "debug",
      describe: "debugging and troubleshooting tools",
      load: () => import("./cli/cmd/debug").then((m) => m.DebugCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "console",
      describe: false,
      load: () => import("./cli/cmd/account").then((m) => m.ConsoleCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "providers",
      aliases: ["auth"],
      describe: "manage AI providers and credentials",
      load: () => import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "agent",
      describe: "manage agents",
      load: () => import("./cli/cmd/agent").then((m) => m.AgentCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "upgrade [target]",
      describe: "upgrade yukioshi to the latest or a specific version",
      load: () => import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "uninstall",
      describe: "uninstall yukioshi and remove all related files",
      load: () => import("./cli/cmd/uninstall").then((m) => m.UninstallCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "serve",
      describe: "starts a headless yukioshi server",
      load: () => import("./cli/cmd/serve").then((m) => m.ServeCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "models [provider]",
      describe: "list all available models",
      load: () => import("./cli/cmd/models").then((m) => m.ModelsCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "stats",
      describe: "show token usage and cost statistics",
      load: () => import("./cli/cmd/stats").then((m) => m.StatsCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "tasks",
      describe:
        "list the background jobs and background subagents of a session, or with --all every running session (read-only)",
      load: () => import("./cli/cmd/tasks").then((m) => m.TasksCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "export [sessionID]",
      describe: "export session data as JSON",
      load: () => import("./cli/cmd/export").then((m) => m.ExportCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "import [file]",
      describe: "import a session: an exported JSON file, a share URL, or a Claude Code or Codex conversation (.jsonl)",
      load: () => import("./cli/cmd/import").then((m) => m.ImportCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "pr <number>",
      describe: "fetch and checkout a GitHub PR branch, then run yukioshi",
      load: () => import("./cli/cmd/pr").then((m) => m.PrCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "session",
      describe: "manage sessions",
      load: () => import("./cli/cmd/session").then((m) => m.SessionCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "plugin [action] [target] [extra]",
      aliases: ["plug"],
      describe: "install, list, or remove plugins (npm packages, or Claude Code plugins/marketplaces from git)",
      load: () => import("./cli/cmd/plug").then((m) => m.PluginCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "trust [directory]",
      describe: "allow this project to run its own hooks, plugins, and commands",
      load: () => import("./cli/cmd/trust").then((m) => m.TrustCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "checkpoint <action> [id]",
      describe: "list, inspect, restore, or prune durable git checkpoints",
      load: () => import("./cli/cmd/checkpoint").then((m) => m.CheckpointCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "schedule",
      describe: "manage scheduled tasks and recurring runs",
      load: () => import("./cli/cmd/schedule").then((m) => m.ScheduleCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "skill <action> [target]",
      describe: "install, list, or remove skills from git repositories",
      load: () => import("./cli/cmd/skill").then((m) => m.SkillCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "worktree <action> [name]",
      describe: "create, list, locate, or remove git worktrees for parallel sessions",
      load: () => import("./cli/cmd/worktree").then((m) => m.WorktreeCommand),
    }),
  )
  .command(
    lazyCommand({
      command: "db",
      describe: "open an interactive sqlite3 shell or run a query",
      load: () => import("./cli/cmd/db").then((m) => m.DbCommand),
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
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
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
