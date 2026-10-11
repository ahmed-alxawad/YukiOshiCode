import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@yukioshi/tui/util/error"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running yukioshi server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "address of a running server, for example http://localhost:4096 (start one with `yukioshi serve`)",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
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
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      }),
  handler: async (args) => {
    // Without a terminal nothing interactive can start, and the commands below report that themselves.
    const unreachable = process.stdout.isTTY ? await serverUnreachableMessage(args.url) : undefined
    if (unreachable) {
      UI.error(unreachable)
      process.exitCode = 1
      return
    }
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        attach: args.url,
        directory,
        password: args.password,
        username: args.username,
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const { TuiConfig } = await import("@/config/tui")
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exitCode = 1
      return
    }

    const headers = ServerAuth.headers({ password: args.password, username: args.username })
    const config = await TuiConfig.get()

    try {
      await validateSession({
        url: args.url,
        sessionID: args.session,
        directory,
        headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return
    }

    const { Effect } = await import("effect")
    const { run } = await import("../tui/layer")
    const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
    await Effect.runPromise(
      run({
        url: args.url,
        config,
        pluginHost: createLegacyTuiPluginHost(),
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      }),
    )
  },
})

/**
 * Fails fast, in words, when nothing answers at the attach URL. Any HTTP answer, even a refusal, means a server is
 * there; the interactive screens would otherwise start first and show a raw connection error.
 */
export async function serverUnreachableMessage(
  url: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string | undefined> {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol")
    host = parsed.host
  } catch {
    return `"${url}" is not a server address. Use a full URL such as http://localhost:4096 (start a server with \`yukioshi serve\`).`
  }
  try {
    await fetcher(url, { signal: AbortSignal.timeout(5000) })
    return undefined
  } catch {
    return `Could not reach a YukiOshi server at ${host}. Start one with \`yukioshi serve\` (it prints its address), check that the URL and port are right, and check any firewall or VPN in between.`
  }
}
