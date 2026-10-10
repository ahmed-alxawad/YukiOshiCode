import { Effect } from "effect"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@yukioshi/core/flag/flag"
import { Config } from "../../config/config"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .example("$0 serve --port 4096", "serve on a fixed port; then `yukioshi attach http://localhost:4096`")
      .example(
        "YUKIOSHI_SERVER_PASSWORD=secret $0 serve --hostname 0.0.0.0",
        "reachable from other machines, password protected",
      ),
  describe: "starts a headless yukioshi server",
  // Server loads instances per-request via x-yukioshi-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.YUKIOSHI_SERVER_PASSWORD) {
      console.log("Warning: YUKIOSHI_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const configSvc = yield* Config.Service
    const globalConfig = yield* configSvc.getGlobal()
    if (globalConfig.triggers?.enabled) {
      const { resolveTriggers } = yield* Effect.promise(() => import("../../server/trigger"))
      const resolved = resolveTriggers(globalConfig)
      if (!resolved.enabled && resolved.reason) {
        console.error(resolved.reason)
      }
    }
    const opts = yield* resolveNetworkOptions(args)
    if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
      return yield* fail(
        `Invalid --port value${Number.isNaN(opts.port) ? " (it is not a number)" : `: ${opts.port}`}. Use a whole number from 1 to 65535, or 0 to pick a free port.`,
      )
    const server = yield* Effect.tryPromise({
      try: () => Server.listen(opts),
      catch: (error) => new CliError({ message: serveStartMessage(error, opts.hostname, opts.port) }),
    })
    console.log(`yukioshi server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})

/** Plain-words reason the server could not start, with what to try next. */
export function serveStartMessage(error: unknown, hostname: string, port: number) {
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as { code?: unknown }).code ?? "")} ${String(error.cause ?? "")}`
      : String(error)
  if (/EADDRINUSE|address already in use|in use/i.test(text))
    return `Port ${port} on ${hostname} is already in use. Stop the program using it, or pick another port with \`yukioshi serve --port <number>\` (--port 0 picks a free one).`
  if (/EACCES|permission denied/i.test(text))
    return `Not allowed to listen on port ${port}. Ports below 1024 need elevated rights; use \`--port 4096\` or another high port.`
  if (/EADDRNOTAVAIL|ENOTFOUND|getaddrinfo/i.test(text))
    return `Cannot listen on "${hostname}": that address does not exist on this machine. Use \`--hostname 127.0.0.1\` (this computer only) or \`--hostname 0.0.0.0\` (all interfaces).`
  return `Could not start the server on ${hostname}:${port}. Run again with \`--print-logs --log-level DEBUG\` for details.`
}
