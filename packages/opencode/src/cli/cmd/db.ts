import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@yukioshi/core/database/database"
import { Cause, Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"
import { errorMessage } from "../../util/error"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db
        .all<Record<string, unknown>>(sql.raw(query))
        .pipe(
          Effect.catchCause((cause) =>
            fail(
              `The SQL statement failed: ${errorMessage(Cause.squash(cause))}. Check the statement; \`yukioshi db path\` prints the database file so you can look at the tables with sqlite3.`,
            ),
          ),
        )
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    const started = yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          child.on("error", () => resolve(false))
          child.on("close", () => resolve(true))
        }),
    )
    if (!started)
      return yield* fail(
        'The sqlite3 program is not installed or not on your PATH. Install it, or pass a statement instead: `yukioshi db "select count(*) from session"`.',
      )
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
