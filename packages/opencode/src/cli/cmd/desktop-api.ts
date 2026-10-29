import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { CliError, effectCmd } from "../effect-cmd"

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

export interface DesktopApiConfig {
  workspace: string
  token: string
}

/** Resolve the only workspace before the server starts; requests never select another path. */
export async function resolveDesktopApiConfig(
  workspace: string,
  token = process.env.KOTHORA_DESKTOP_TOKEN,
): Promise<DesktopApiConfig> {
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new Error("KOTHORA_DESKTOP_TOKEN must be a 32-byte-or-longer base64url token")
  }
  const canonical = await realpath(path.resolve(workspace))
  if (!(await stat(canonical)).isDirectory()) throw new Error("Desktop workspace must be a directory")
  return { workspace: canonical, token }
}

export const DesktopApiCommand = effectCmd({
  command: "desktop-api <workspace>",
  describe: false,
  builder: (yargs) =>
    yargs.positional("workspace", {
      type: "string",
      demandOption: true,
      describe: "canonical workspace selected by the desktop app",
    }),
  instance: false,
  handler: Effect.fn("Cli.desktopApi")(function* (args) {
    const config = yield* Effect.tryPromise({
      try: () => resolveDesktopApiConfig(args.workspace),
      catch: (error) =>
        new CliError({ message: error instanceof Error ? error.message : "Invalid desktop API configuration" }),
    })
    process.env.KOTHORA_DESKTOP_WORKSPACE = config.workspace
    process.env.YUKIOSHI_SERVER_USERNAME = "kothora-desktop"
    process.env.YUKIOSHI_SERVER_PASSWORD = config.token

    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const server = yield* Effect.tryPromise({
      try: () =>
        Server.listen({
          hostname: "127.0.0.1",
          port: 0,
          mdns: false,
          cors: [],
          randomPort: true,
        }),
      catch: () => new CliError({ message: "Could not start the desktop agent core on this computer." }),
    })

    // Machine-readable bootstrap contains no credential; the parent already owns the token.
    process.stdout.write(`${JSON.stringify({ type: "ready", hostname: "127.0.0.1", port: server.port })}\n`)
    yield* Effect.never
  }),
})
