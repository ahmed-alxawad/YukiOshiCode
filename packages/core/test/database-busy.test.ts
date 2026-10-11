import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Database } from "@yukioshi/core/database/database"

// Another process holding the file briefly (for example while it migrates) must delay opening, not fail it with
// "database is locked": the WAL switch used to run before any busy timeout was set.
test("opening a database waits for a concurrent writer instead of failing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yk-db-busy-"))
  const file = path.join(dir, "busy.sqlite")
  // Opening is synchronous, so the lock has to be held by another process.
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(file)}); db.run("BEGIN EXCLUSIVE"); console.log("locked"); setTimeout(() => { db.run("COMMIT"); process.exit(0) }, 1000)`,
    ],
    { stdout: "pipe" },
  )
  await holder.stdout.getReader().read()
  try {
    const opened = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Database.Service
          return yield* service.db.run("SELECT 1")
        }).pipe(Effect.provide(Database.layerFromPath(file))),
      ),
    )
    expect(opened).toBeDefined()
  } finally {
    holder.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
