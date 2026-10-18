import { Effect } from "effect"
import { Database } from "@yukioshi/core/database/database"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* Database.Service
      yield* service.db.run("SELECT 1")
    }).pipe(Effect.provide(Database.layerFromPath(process.argv[2]!))),
  ),
)
