import type { Argv } from "yargs"
import { Effect } from "effect"
import { SkillInstall } from "../../skill/install"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type Args = { action?: "add" | "list" | "remove"; target?: string; name?: string }

function userFacing<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
  })
}

export const SkillCommand = effectCmd({
  command: "skill <action> [target]",
  describe: "install, list, or remove skills from git repositories",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { choices: ["add", "list", "remove"] as const })
      .positional("target", { type: "string", describe: "git URL (add) or installed name (remove)" })
      .option("name", { type: "string", describe: "folder name to install under (add); defaults to the repository name" }),
  handler: Effect.fn("Cli.skill")(function* (args: Args) {
    if (args.action === "list") {
      const items = yield* userFacing(() => SkillInstall.list())
      if (!items.length) UI.println("No skills installed from git. Add one with: yukioshi skill add <git-url>")
      for (const item of items) {
        UI.println(`${item.name}  ${item.url}`)
        UI.println(`  skills: ${item.skills.join(", ")}`)
      }
      return
    }

    if (args.action === "add") {
      if (!args.target) return yield* fail("skill add needs a git URL")
      const target = args.target
      const installed = yield* userFacing(() => SkillInstall.add({ url: target, name: args.name }))
      UI.println(`Installed ${installed.name} from ${installed.url}`)
      UI.println(`Skills found: ${installed.skills.join(", ")}`)
      UI.println("Only the Markdown was kept; nothing from the repository was run.")
      return
    }

    if (!args.target) return yield* fail("skill remove needs a name; see yukioshi skill list")
    const target = args.target
    yield* userFacing(() => SkillInstall.remove(target))
    UI.println(`Removed ${target}`)
  }),
})
