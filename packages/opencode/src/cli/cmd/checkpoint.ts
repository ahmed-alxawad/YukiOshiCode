import type { Argv } from "yargs"
import { Effect } from "effect"
import { Checkpoint } from "@/checkpoint"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { InstanceRef } from "@/effect/instance-ref"

type Args = { action?: string; id?: string; session?: string; yes: boolean; "older-than": string }

function age(value: string) {
  const match = /^(\d+)\s*([dhm])$/.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 } as const)[match[2] as "d" | "h" | "m"]
}

function userFacing<A, R>(effect: Effect.Effect<A, Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new CliError({
          message: /not a git repository/i.test(error.message)
            ? "This folder is not a git repository, and checkpoints live in one. cd into your project (or run `git init`) and try again."
            : error.message,
        }),
    ),
  )
}

export const CheckpointCommand = effectCmd({
  command: "checkpoint <action> [id]",
  describe: "list, inspect, restore, or prune durable git checkpoints",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        choices: ["list", "show", "restore", "prune"] as const,
        describe: "list checkpoints, show or restore one by id, or prune old ones",
      })
      .positional("id", { type: "string", describe: "checkpoint commit id (for show or restore)" })
      .option("session", { type: "string", describe: "limit list to a session id" })
      .option("yes", { type: "boolean", default: false, describe: "confirm restoring over unsaved changes" })
      .option("older-than", {
        type: "string",
        default: "30d",
        describe: "prune refs older than this age (30d, 12h or 90m)",
      })
      .example("$0 checkpoint list", "list checkpoints for this project")
      .example("$0 checkpoint restore 1a2b3c4d5e6f", "put the files back as they were at that checkpoint"),
  handler: Effect.fn("Cli.checkpoint")(function* (args: Args) {
    const ctx = yield* InstanceRef
    if (ctx && ctx.project.vcs !== "git")
      return yield* fail(
        "This folder is not a git repository, and checkpoints live in one. cd into your project (or run `git init`) and try again.",
      )
    const checkpoints = yield* Checkpoint.Service
    if (args.action === "list") {
      const items = yield* userFacing(checkpoints.list(args.session))
      for (const item of items) {
        UI.println(
          `${item.id.slice(0, 12)}  ${new Date(item.time * 1000).toISOString()}  ${item.sessionID}  ${item.message.split("\n", 1)[0]}`,
        )
        if (item.files.length) UI.println(`  ${item.files.join(", ")}`)
      }
      if (!items.length) UI.println("No checkpoints.")
      return
    }
    if (args.action === "show") {
      if (!args.id)
        return yield* fail(
          "checkpoint show needs a checkpoint id. Run `yukioshi checkpoint list` to see the ids, then `yukioshi checkpoint show <id>`.",
        )
      UI.println(yield* userFacing(checkpoints.show(args.id)))
      return
    }
    if (args.action === "restore") {
      if (!args.id)
        return yield* fail(
          "checkpoint restore needs a checkpoint id. Run `yukioshi checkpoint list` to see the ids, then `yukioshi checkpoint restore <id>`.",
        )
      const root = yield* userFacing(
        checkpoints.restore({ id: args.id, yes: args.yes, sessionID: args.session ?? "manual" }),
      )
      UI.println(`Restored ${args.id} in ${root}`)
      return
    }
    if (args.action !== "prune")
      return yield* fail(
        `Unknown checkpoint action "${args.action}". Use one of: list, show <id>, restore <id>, prune.`,
      )
    const olderThan = age(args["older-than"])
    if (olderThan === undefined)
      return yield* fail(
        `Invalid --older-than value "${args["older-than"]}". Use a number and a unit: 30d, 12h or 90m.`,
      )
    const removed = yield* userFacing(checkpoints.prune(olderThan))
    UI.println(`Pruned ${removed} checkpoint ref${removed === 1 ? "" : "s"}.`)
  }),
})
