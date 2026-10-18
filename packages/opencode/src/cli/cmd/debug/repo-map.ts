import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const RepoMapCommand = effectCmd({
  command: "repo-map",
  describe: "print the repo map (ranked files and definitions) that repo_map.enabled adds to the system context",
  builder: (yargs) => yargs.option("tokens", { describe: "token budget (default: repo_map.tokens or 1024)", type: "number" }),
  handler: Effect.fn("Cli.debug.repoMap")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { SessionRepoMap } = yield* Effect.promise(() => import("@/session/repo-map"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const tokens = args.tokens ?? config.repo_map?.tokens ?? SessionRepoMap.DEFAULT_TOKENS
    const text = SessionRepoMap.build(process.cwd(), tokens)
    console.log(text || "No definitions found.")
    console.log(`repo_map.enabled: ${config.repo_map?.enabled === true}`)
  }),
})
