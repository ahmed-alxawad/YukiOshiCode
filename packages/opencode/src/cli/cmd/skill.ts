import type { Argv } from "yargs"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { ProjectTrust } from "@/project/trust"
import { SkillInstall } from "../../skill/install"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type Args = {
  action?: "add" | "list" | "remove"
  targets?: string[]
  name?: string
  select?: string
  all?: boolean
  list?: boolean
  force?: boolean
  global?: boolean
  project?: boolean
  fromFile?: string
}

// One source per line; blank lines and "#" comments (whole line, or after whitespace) are ignored.
export function parseSourceList(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean)
}

function userFacing<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
  })
}

export const SkillCommand = effectCmd({
  command: "skill <action> [targets..]",
  describe: "install, list, or remove skills from git repositories, folders, or archives",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        choices: ["add", "list", "remove"] as const,
        describe: "add a skill repository, list installed ones, or remove one",
      })
      .positional("targets", {
        type: "string",
        array: true,
        describe: "sources to add (git URLs, folders, .zip/.tar.gz archives) or the installed name to remove",
      })
      .option("select", { type: "string", describe: "install only these skills (comma-separated names)" })
      .option("all", { type: "boolean", describe: "install every skill found (default)" })
      .option("list", { type: "boolean", describe: "show the skills found in the sources without installing" })
      .option("force", { type: "boolean", describe: "replace a source that is already installed" })
      .option("global", { type: "boolean", describe: "install for every project (default)" })
      .option("project", { type: "boolean", describe: "install into this project (needs a trusted project)" })
      .option("from-file", { type: "string", describe: "read sources from a file, one per line (# for comments)" })
      .option("name", {
        type: "string",
        describe: "folder name to install under (add); defaults to the repository name",
      })
      .example("$0 skill add https://github.com/owner/skills-repo", "install the skills in a git repository"),
  handler: Effect.fn("Cli.skill")(function* (args: Args) {
    if (args.global && args.project)
      return yield* fail("--global and --project cannot be combined. Pick one install location.")
    const base = yield* userFacing(async () => {
      if (!args.project) return undefined
      const top = await ProjectTrust.resolveRoot(process.cwd())
      if (args.action === "add" && !args.list && !(await ProjectTrust.isTrusted(top)))
        throw new Error(`${top} is not trusted, so skills cannot be installed into it. Run \`yukioshi trust\` there first.`)
      return path.join(top, ".yukioshi", "skills")
    })

    if (args.action === "list") {
      const items = yield* userFacing(() => SkillInstall.list(base))
      if (!items.length) UI.println("No skills installed from git. Add one with: yukioshi skill add <git-url>")
      for (const item of items) {
        UI.println(`${item.name}  ${item.url}`)
        UI.println(`  skills: ${item.skills.join(", ")}`)
      }
      return
    }

    if (args.action === "add") {
      const fromFile = args.fromFile
      const sources = [
        ...(args.targets ?? []),
        ...(fromFile ? parseSourceList(yield* userFacing(() => fs.readFile(fromFile, "utf8"))) : []),
      ]
      if (!sources.length)
        return yield* fail(
          "skill add needs a source. Example: `yukioshi skill add https://github.com/owner/skills-repo ./my-skills team.zip`, or `--from-file skills.txt`.",
        )
      if (args.all && args.select) return yield* fail("--all and --select cannot be combined.")
      const select = args.select?.split(",").map((item) => item.trim()).filter(Boolean)
      const outcomes = yield* userFacing(() =>
        SkillInstall.addMany({ sources, name: args.name, select, force: args.force, listOnly: args.list, root: base }),
      )
      for (const item of outcomes) {
        const label = { installed: "installed", skipped: "skipped", failed: "failed", found: "found" }[item.status]
        const detail = item.reason ?? item.skills.join(", ")
        UI.println(`${label.padEnd(10)} ${item.source}${item.name && !args.list ? ` -> ${item.name}` : ""}${detail ? `  ${detail}` : ""}`)
      }
      const count = (status: string) => outcomes.filter((item) => item.status === status).length
      UI.println(
        args.list
          ? `${count("found")} source(s) listed, ${count("failed")} failed. Nothing was installed.`
          : `${count("installed")} installed, ${count("skipped")} skipped, ${count("failed")} failed. Only the Markdown was kept; nothing from the sources was run.`,
      )
      if (count("failed")) return yield* fail(`${count("failed")} source(s) failed.`)
      return
    }

    const target = args.targets?.[0]
    if (!target)
      return yield* fail(
        "skill remove needs a name. Run `yukioshi skill list` to see what is installed, then `yukioshi skill remove <name>`.",
      )
    yield* userFacing(() => SkillInstall.remove(target, base))
    UI.println(`Removed ${target}`)
  }),
})
