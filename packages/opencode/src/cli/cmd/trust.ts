import { Effect } from "effect"
import type { Argv } from "yargs"
import { ProjectTrust } from "@/project/trust"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type Args = {
  directory?: string
  revoke: boolean
  status: boolean
}

export const TrustCommand = effectCmd({
  command: "trust [directory]",
  describe: "allow this project to run its own hooks and plugins",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("directory", {
        describe: "project directory (defaults to the current directory)",
        type: "string",
      })
      .option("revoke", {
        describe: "remove previously granted project trust",
        type: "boolean",
        default: false,
      })
      .option("status", {
        describe: "show whether the project is trusted without changing it",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.trust")(function* (args: Args) {
    if (args.revoke && args.status) yield* fail("Use either --revoke or --status, not both.")

    const requested = ProjectTrust.canonical(args.directory ?? process.cwd())
    const root = yield* Effect.promise(() => ProjectTrust.resolveRoot(requested))

    if (args.status) {
      const trusted = yield* Effect.promise(() => ProjectTrust.isTrusted(root))
      UI.println(`${root}: ${trusted ? "trusted" : "untrusted"}`)
    } else {
      yield* Effect.promise(() => ProjectTrust.set(root, !args.revoke))
      UI.println(args.revoke ? `Revoked trust for ${root}` : `Trusted ${root}`)
      if (!args.revoke) UI.println("Project hooks and plugins will be enabled the next time this project is opened.")
    }
  }),
})
