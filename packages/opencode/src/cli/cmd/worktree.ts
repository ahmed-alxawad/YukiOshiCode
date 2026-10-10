import type { Argv } from "yargs"
import { Effect } from "effect"
import { Worktree } from "@/worktree"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { resolveWorktree, worktreeSlug } from "../worktree"

type Args = { action?: "new" | "list" | "path" | "remove"; name?: string; yes: boolean }

function userFacing<A, R>(effect: Effect.Effect<A, { message: string }, R>) {
  return effect.pipe(Effect.mapError((error) => new CliError({ message: error.message })))
}

function gitLines(args: string[], cwd: string) {
  return Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text.split("\n").filter((line) => line.trim() !== "")
  })
}

export const WorktreeCommand = effectCmd({
  command: "worktree <action> [name]",
  describe: "create, list, locate, or remove git worktrees for parallel sessions",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        choices: ["new", "list", "path", "remove"] as const,
        describe: "create a worktree, list them, print one's path, or remove one",
      })
      .positional("name", { type: "string", describe: "worktree name" })
      .option("yes", { type: "boolean", default: false, describe: "remove even with uncommitted changes" })
      .example("$0 worktree new fix-login", "create a worktree to work on in parallel")
      .example('cd "$($0 worktree path fix-login)"', "go to it"),
  handler: Effect.fn("Cli.worktree")(function* (args: Args) {
    const worktrees = yield* Worktree.Service

    if (args.action === "list") {
      const items = yield* userFacing(worktrees.list())
      if (!items.length) UI.println("No worktrees. Create one with: yukioshi worktree new <name>")
      for (const item of items) UI.println(`${item.name}  ${item.branch ?? "(detached)"}  ${item.directory}`)
      return
    }

    if (args.action === "new") {
      const info = yield* userFacing(resolveWorktree(args.name))
      UI.println(
        info.created
          ? `Created worktree ${info.name}${info.branch ? ` on branch ${info.branch}` : ""}.`
          : `Worktree ${info.name} already exists.`,
      )
      UI.println(info.directory)
      UI.println(`Start a session in it: yukioshi --worktree ${info.name}, or yukioshi run --worktree ${info.name} "…"`)
      return
    }

    if (!args.name) return yield* fail(`worktree ${args.action} needs a name; see yukioshi worktree list`)
    const wanted = worktreeSlug(args.name)
    const found = (yield* userFacing(worktrees.list())).find((item) => item.name === wanted)
    if (!found) return yield* fail(`No worktree named ${args.name}; see yukioshi worktree list`)

    if (args.action === "path") {
      // On stdout, for `cd "$(yukioshi worktree path <name>)"`.
      process.stdout.write(found.directory + "\n")
      return
    }

    // remove deletes the worktree's files and its branch, so never drop work without asking: uncommitted
    // changes, or commits on the branch that are not on the branch you are working on.
    const changes = yield* gitLines(["status", "--short"], found.directory)
    const unmerged = found.branch ? yield* gitLines(["log", "--oneline", `HEAD..${found.branch}`], process.cwd()) : []
    if ((changes.length || unmerged.length) && !args.yes) {
      const parts = [
        ...(changes.length ? [`${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}`] : []),
        ...(unmerged.length
          ? [
              `${unmerged.length} commit${unmerged.length === 1 ? "" : "s"} on ${found.branch} not on your current branch`,
            ]
          : []),
      ]
      return yield* fail(
        `Worktree ${found.name} has ${parts.join(" and ")}. Merge or save that work first, or run again with --yes to delete it.`,
      )
    }
    yield* userFacing(worktrees.remove({ directory: found.directory }))
    UI.println(`Removed worktree ${found.name}${found.branch ? ` and its branch ${found.branch}` : ""}.`)
  }),
})
