import type { Argv } from "yargs"
import { Effect } from "effect"
import { Checkpoint } from "@/checkpoint"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type Args = { action?: string; id?: string; session?: string; yes: boolean; "older-than": string }

function age(value: string) {
  const match = /^(\d+)\s*([dhm])$/.exec(value.trim())
  if (!match) throw new Error(`Invalid age: ${value} (use 30d, 12h, or 90m)`)
  return Number(match[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 } as const)[match[2] as "d" | "h" | "m"]
}

function userFacing<A, R>(effect: Effect.Effect<A, Error, R>) {
  return effect.pipe(Effect.mapError((error) => new CliError({ message: error.message })))
}

export const CheckpointCommand = effectCmd({
  command: "checkpoint <action> [id]",
  describe: "list, inspect, restore, or prune durable git checkpoints",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { choices: ["list", "show", "restore", "prune"] as const })
      .positional("id", { type: "string", describe: "checkpoint commit id (for show or restore)" })
      .option("session", { type: "string", describe: "limit list to a session id" })
      .option("yes", { type: "boolean", default: false, describe: "confirm restoring over unsaved changes" })
      .option("older-than", { type: "string", default: "30d", describe: "prune refs older than this age" }),
  handler: Effect.fn("Cli.checkpoint")(function* (args: Args) {
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
      if (!args.id) return yield* fail("checkpoint show requires an id")
      UI.println(yield* userFacing(checkpoints.show(args.id)))
      return
    }
    if (args.action === "restore") {
      if (!args.id) return yield* fail("checkpoint restore requires an id")
      const root = yield* userFacing(
        checkpoints.restore({ id: args.id, yes: args.yes, sessionID: args.session ?? "manual" }),
      )
      UI.println(`Restored ${args.id} in ${root}`)
      return
    }
    const removed = yield* userFacing(checkpoints.prune(age(args["older-than"])))
    UI.println(`Pruned ${removed} checkpoint ref${removed === 1 ? "" : "s"}.`)
  }),
})
