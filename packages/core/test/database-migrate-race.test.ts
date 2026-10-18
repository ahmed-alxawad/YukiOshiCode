import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { migrations } from "@yukioshi/core/database/migration.gen"

const script = path.resolve(import.meta.dir, "fixture/database-open.fixture.ts")

// Several processes starting on the same fresh database file must not race the first-start migration.
test("concurrent first start on a fresh database migrates exactly once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yk-db-race-"))
  const file = path.join(dir, "fresh.sqlite")
  try {
    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, script, file], {
        env: { ...process.env, XDG_STATE_HOME: path.join(dir, "state"), XDG_DATA_HOME: path.join(dir, "data") },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })),
    )
    expect(results.filter((r) => r.code !== 0).map((r) => r.err)).toEqual([])
    const db = new Sqlite(file, { readonly: true })
    const ids = db.query<{ id: string }, []>("SELECT id FROM migration").all().map((r) => r.id)
    db.close()
    expect(ids.sort()).toEqual(migrations.map((m) => m.id).sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
