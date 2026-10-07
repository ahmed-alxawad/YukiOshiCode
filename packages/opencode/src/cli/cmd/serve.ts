import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@yukioshi/core/flag/flag"
import { Config } from "../../config/config"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
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
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`yukioshi server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
