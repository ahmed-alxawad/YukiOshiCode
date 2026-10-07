import type { PermissionV1 } from "@yukioshi/core/v1/permission"
import { RiskClassifier } from "@yukioshi/core/permission/risk"
import { FSUtil } from "@yukioshi/core/fs-util"
// CLI entry point for `yukioshi run` and `yukioshi --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`yukioshi --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`yukioshi --mini --attach`): connects to a running
//      yukioshi server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@yukioshi/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { readPipedInput } from "../stdin"
import { executePostTurnVerification } from "./run/verification"
import { EXIT, dollars, goalExitCode, readOutputSchema } from "./run/outcome"
import { formatFileChanges, type FileChange } from "@yukioshi/core/files-changed-summary"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run yukioshi with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "mode or agent: build, plan, goal, reasoning, research, auto, or a custom agent",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running yukioshi server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to YUKIOSHI_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to YUKIOSHI_SERVER_USERNAME or 'yukioshi')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("worktree", {
        type: "string",
        describe: "run in a git worktree of this project with this name (created if needed)",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("verify", {
        type: "boolean",
        describe: "run full project verification on changed files (off by default)",
        default: false,
      })
      .option("skip-verify", {
        type: "boolean",
        describe: "skip verification checks after turn completion",
      })
      // Defined as `summary` so yargs' own negation handles --no-summary.
      .option("summary", {
        type: "boolean",
        default: true,
        describe: "print the files changed after the turn (--no-summary to turn off)",
      })
      .option("output-schema", {
        type: "string",
        describe: "JSON Schema (a file, or inline JSON) the final answer must match; the answer is printed as JSON",
      })
      .option("max-turns", {
        type: "number",
        describe: "stop after this many model turns (exit code 5)",
      })
      .option("max-cost", {
        type: "number",
        describe: "stop once this run has cost this many dollars (exit code 6)",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mode", {
        type: "string",
        choices: ["manual", "auto", "auto-all", "plan", "review"] as const,
        describe:
          "permission mode for this session: manual asks for anything not explicitly configured, auto auto-approves low-risk actions (reads/searches), auto-all auto-approves anything not explicitly denied or hard-blocked, plan restricts the agent to low-risk actions only, review has a small model approve or refuse each action that is not low-risk",
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    if (args.worktree !== undefined && !args.attach) {
      if (args.dir) return yield* fail("Use either --dir or --worktree, not both.")
      const { resolveWorktree } = yield* Effect.promise(() => import("../worktree"))
      const worktree = yield* resolveWorktree(args.worktree).pipe(
        Effect.mapError((error) => new CliError({ message: error.message })),
      )
      process.stderr.write(
        `${worktree.created ? "Created" : "Using"} worktree ${worktree.name}${worktree.branch ? ` (${worktree.branch})` : ""}: ${worktree.directory}\n`,
      )
      args.dir = worktree.directory
    }
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const interactive = args.mini
      const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      const words = [...args.message, ...(args["--"] || [])]
      // One argument (the usual `yukioshi run "fix the login bug"`) is the message exactly as typed;
      // with several, arguments containing spaces are quoted so their grouping survives the join.
      let message =
        words.length === 1
          ? words[0]!
          : words.map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ")

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const maxTurns = args["max-turns"]
      const maxCost = args["max-cost"]
      if (interactive && (args["output-schema"] !== undefined || maxTurns !== undefined || maxCost !== undefined)) {
        die("--output-schema, --max-turns and --max-cost cannot be used with --mini")
      }
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
        die("--max-turns must be a positive whole number")
      }
      if (maxCost !== undefined && !(maxCost > 0)) {
        die("--max-cost must be a positive number of dollars")
      }
      if (args["output-schema"] !== undefined && args.command) {
        die("--output-schema cannot be used with --command")
      }
      const outputSchema =
        args["output-schema"] === undefined
          ? undefined
          : await readOutputSchema(args["output-schema"]).catch((error: Error) => die(error.message))

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createOpencodeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = await readPipedInput(message.trim().length > 0 || Boolean(args.command))
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !interactive) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title) return args.title
        // A one-shot run is named after its prompt instead of spending an extra model call on a title.
        if (args.title === undefined && interactive) return
        if (!message.trim()) return
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: OpencodeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function share(sdk: OpencodeClient, sessionID: string) {
        const cfg = await sdk.config.get()
        if (!cfg.data) return
        if (cfg.data.share !== "auto" && !flags.autoShare && !args.share) return
        const res = await sdk.session.share({ sessionID }).catch((error) => ({ error }))
        if (res.error) UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + formatRunError(res.error))
        if (!res.error && "data" in res && res.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
        }
      }

      async function createFreshSession(
        sdk: OpencodeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        void share(sdk, id).catch(() => {})
        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: OpencodeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      function unknownAgent(
        name: string,
        agents: readonly { name: string; mode: string; hidden?: boolean }[],
        reason = "Agent not found",
      ): never {
        const names = agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => a.name)
        UI.error(`${reason}: "${name}".${names.length ? ` Available: ${names.join(", ")}` : ""}`)
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          // A typo in --agent must not silently run the task in another mode (for example Build).
          const available = await Effect.runPromise(
            agentSvc.list().pipe(Effect.provideService(InstanceRef, localInstance)),
          )
          unknownAgent(name, available)
        }
        if (entry.mode === "subagent") {
          // Like an unknown name: never run the task in a different mode than the one asked for.
          const available = await Effect.runPromise(
            agentSvc.list().pipe(Effect.provideService(InstanceRef, localInstance)),
          )
          unknownAgent(name, available, "Only other agents can start this subagent")
        }
        return name
      }

      async function attachAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) unknownAgent(name, modes)

        if (agent.mode === "subagent") unknownAgent(name, modes, "Only other agents can start this subagent")

        return name
      }

      async function pickAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: OpencodeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        const mode = args.mode ?? (auto ? "auto-all" : undefined)
        if (mode) await sdk.v2.session.permission.mode.set({ sessionID, mode })

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        let summaryDiffs: FileChange[] = []
        // Set once the run has reported its own failure: the same failure also arrives as a session.error
        // event, which must not be printed a second time.
        let reported = false
        // --max-turns counts this session's model turns; --max-cost adds up the cost of every reply in the run,
        // subagents included. Reaching either stops the session, and the run exits with its own code.
        let turns = 0
        let stopped: "turns" | "cost" | undefined
        let budgetBlocked = false
        const replyCosts = new Map<string, number>()
        const countedTurns = new Set<string>()
        const spent = () => [...replyCosts.values()].reduce((sum, cost) => sum + cost, 0)
        async function stop(client: OpencodeClient, reason: "turns" | "cost") {
          if (stopped) return
          stopped = reason
          await client.session.abort({ sessionID }).catch(() => undefined)
        }
        async function loop(client: OpencodeClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          const sessions = new Set([sessionID])
          // Background subagents still to report back, by subagent session. Each one reports to this session
          // when it finishes and the session then continues, so the run only ends once all have reported.
          const outstanding = new Map<string, number>()
          const counted = new Set<string>()
          const count = (id: string, change: number) => outstanding.set(id, (outstanding.get(id) ?? 0) + change)
          let error: string | undefined

          for await (const event of events.stream) {
            if (reported) break
            if (event.type === "session.created" && event.properties.info.parentID) {
              if (sessions.has(event.properties.info.parentID)) sessions.add(event.properties.info.id)
            }

            if (
              event.type === "message.updated" &&
              event.properties.info.role === "assistant" &&
              sessions.has(event.properties.info.sessionID)
            ) {
              replyCosts.set(event.properties.info.id, event.properties.info.cost ?? 0)
              if (maxCost !== undefined && spent() >= maxCost) await stop(client, "cost")
            }

            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.updated" && event.properties.sessionID === sessionID) {
              if (event.properties.info.role === "user") summaryDiffs = event.properties.info.summary?.diffs ?? []
            }

            // A later reply that completes cleanly (for example on a fallback model after the first model
            // failed) means the turn succeeded; the exit code reflects how the turn ended.
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              event.properties.info.time.completed &&
              !event.properties.info.error
            ) {
              error = undefined
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "completed" &&
                part.state.metadata?.background === true &&
                typeof part.state.metadata.sessionId === "string" &&
                !counted.has(part.id)
              ) {
                counted.add(part.id)
                count(part.state.metadata.sessionId, 1)
              }
              if (part.type === "text" && part.synthetic && !counted.has(part.id)) {
                counted.add(part.id)
                for (const match of part.text.matchAll(/<task id="([^"]+)"/g)) count(match[1]!, -1)
              }

              if (part.type === "step-finish" && !countedTurns.has(part.id)) {
                countedTurns.add(part.id)
                turns++
                // The model asked for tools, so another turn would follow: stop before it starts.
                if (maxTurns !== undefined && turns >= maxTurns && part.reason === "tool-calls")
                  await stop(client, "turns")
              }
              // A turn beyond the limit, for example a goal's next round, is stopped as it starts.
              if (part.type === "step-start" && maxTurns !== undefined && turns >= maxTurns) await stop(client, "turns")

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  // With --output-schema, stdout carries only the JSON answer.
                  ;(outputSchema ? process.stderr : process.stdout).write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                ;(outputSchema ? process.stderr : process.stdout).write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              // The abort that --max-turns or --max-cost asked for is not an error.
              if (stopped && props.error.name === "MessageAbortedError") continue
              if (props.error.name === "APIError" && props.error.data.metadata?.reason === "budget")
                budgetBlocked = true
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            if (event.type === "tui.toast.show" && event.properties.variant === "warning") {
              const message = event.properties.message
              if (args.format === "json") emit("warning", { message })
              else process.stderr.write(message + EOL)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle" &&
              ![...outstanding.values()].some((left) => left > 0)
            ) {
              break
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (!sessions.has(permission.sessionID)) continue

              // This event is the legacy V1 permission ask (the one actually
              // live for tool execution today - see packages/yukioshi/src/tool/registry.ts
              // and packages/yukioshi/src/permission/index.ts). Since `run`
              // (non-`--mini`) has no interactive prompt, mode resolution
              // happens client-side here rather than server-side.
              const autoApprove =
                auto ||
                mode === "auto-all" ||
                (mode === "auto" && RiskClassifier.classify(permission.permission) === "low")

              if (autoApprove) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        await share(client, sessionID)

        if (!interactive) {
          const events = await client.event.subscribe()
          const completed = loop(client, events).catch((e) => {
            console.error(e)
            process.exitCode = 1
          })
          async function finish() {
            if (args.attach) return
            const error = await completed
            if (error) process.exitCode = 1
            if (args.summary !== false) {
              const summary = formatFileChanges(summaryDiffs, cwd)
              if (summary) process.stderr.write(summary + EOL)
            }
          }

          // Sets the exit code for how the run ended (EXIT in ./run/outcome) and says why on stderr, or in a
          // final "result" event with --format json. With --output-schema the answer goes to stdout as JSON.
          async function outcome(info: { structured?: unknown } | undefined) {
            let code: number = process.exitCode ? EXIT.error : EXIT.ok
            let reason = code ? "error" : "done"
            let note: string | undefined
            if (stopped === "turns") {
              code = EXIT.maxTurns
              reason = "max_turns"
              note = `Stopped after ${turns} turn${turns === 1 ? "" : "s"} (--max-turns ${maxTurns}).`
            } else if (stopped === "cost") {
              code = EXIT.spending
              reason = "max_cost"
              note = `Stopped after spending ${dollars(spent())} (--max-cost ${dollars(maxCost!)}).`
            } else if (budgetBlocked) {
              code = EXIT.spending
              reason = "budget"
            } else if (code === EXIT.ok && outputSchema && info?.structured === undefined) {
              code = EXIT.error
              reason = "invalid_output"
              note = "The model did not give an answer matching --output-schema."
            } else if (code === EXIT.ok && !args.attach) {
              const { SessionGoal } = await import("@/session/goal")
              const goal = await SessionGoal.get(sessionID)
              const goalCode = goalExitCode(goal, started)
              if (goal && goalCode !== undefined) {
                code = goalCode
                reason = goalCode === EXIT.goalRounds ? "goal_rounds" : "goal_blocked"
                note = `Goal paused: ${goal.note ?? "it needs you."}`
              }
            }
            process.exitCode = code
            const answer = code === EXIT.ok && outputSchema ? info?.structured : undefined
            const result = { exit_code: code, reason, turns, cost: spent() }
            if (
              emit("result", {
                ...result,
                ...(note ? { message: note } : {}),
                ...(answer !== undefined ? { structured: answer } : {}),
              })
            )
              return
            if (note) process.stderr.write(note + EOL)
            if (answer !== undefined) process.stdout.write(JSON.stringify(answer) + EOL)
          }
          const started = Date.now()
          // With --output-schema, stdout carries only the answer.
          const verificationOut = outputSchema ? (line: string) => process.stderr.write(line + EOL) : undefined

          if (args.command) {
            const result = await client.session.command({
              sessionID,
              agent,
              model: args.model,
              command: args.command,
              arguments: message,
              variant: args.variant,
            })
            if (result.error) {
              reported = true
              if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
              process.exitCode = 1
              emit("result", { exit_code: EXIT.error, reason: "error", turns, cost: spent() })
              return
            }
            await finish()
            if (args.verify || args["skip-verify"]) {
              await executePostTurnVerification({
                cwd,
                client,
                sessionID,
                promptResult: result,
                emit,
                json: args.format === "json",
                skip: Boolean(args["skip-verify"]),
              })
            }
            await outcome(result.data?.info)
            return
          }

          const model = pick(args.model)
          const result = await client.session.prompt({
            sessionID,
            agent,
            model,
            variant: args.variant,
            parts: [...files, { type: "text", text: message }],
            ...(outputSchema ? { format: { type: "json_schema" as const, schema: outputSchema } } : {}),
          })
          if (result.error) {
            reported = true
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            emit("result", { exit_code: EXIT.error, reason: "error", turns, cost: spent() })
            return
          }
          await finish()
          if (args.verify || args["skip-verify"]) {
            await executePostTurnVerification({
              cwd,
              client,
              sessionID,
              promptResult: result,
              emit,
              json: args.format === "json",
              skip: Boolean(args["skip-verify"]),
              out: verificationOut,
            })
          }
          await outcome(result.data?.info)
          return
        }

        const model = pick(args.model)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (interactive && !args.attach && !args.session && !args.continue) {
        const model = pick(args.model)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: localAgent,
            session,
            share,
            createSession: createFreshSession,
            agent: args.agent,
            model,
            variant: args.variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({
        baseUrl: "http://yukioshi.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "yukioshi",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    share: undefined,
    model: input.model,
    agent: input.agent,
    format: "default",
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    interactive: false,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    worktree: undefined,
    replayLimit: input.replayLimit,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    mode: undefined,
    verify: false,
    "skip-verify": false,
    skipVerify: false,
    summary: true,
    "output-schema": undefined,
    outputSchema: undefined,
    "max-turns": undefined,
    maxTurns: undefined,
    "max-cost": undefined,
    maxCost: undefined,
    demo: input.demo ?? false,
  })
}
