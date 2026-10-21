import type { Argv } from "yargs"
import { Effect } from "effect"
import { Checkpoint } from "@/checkpoint"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { InstanceRef } from "@/effect/instance-ref"

export const UndoCommand = effectCmd({
  command: "undo",
  describe: "revert the last turn's file changes (needs checkpoints.enabled or git.auto_commit)",
  builder: (yargs: Argv) => yargs.option("session", { type: "string", describe: "undo the last turn of this session id (default: the session with the newest checkpoint)" }),
  handler: Effect.fn("Cli.undo")(function* (args: { session?: string }) {
    const ctx = yield* InstanceRef
    if (ctx && ctx.project.vcs !== "git")
      return yield* fail("This folder is not a git repository. cd into your project and try again.")
    const checkpoints = yield* Checkpoint.Service
    const result = yield* checkpoints.undo({ sessionID: args.session }).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    )
    const which = args.session
      ? `session ${result.sessionID}`
      : `session ${result.sessionID} (the most recent; pass --session <id> to choose another)`
    UI.println(
      `Undid the last turn of ${which} in ${result.root}${result.droppedCommit ? " and dropped its unpushed auto-commit" : ""}.`,
    )
  }),
})
