import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { redactConfig } from "./redact"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const redacted = redactConfig(config)
    if (
      redacted &&
      typeof redacted === "object" &&
      "$schema" in redacted &&
      (redacted as Record<string, unknown>).$schema === "https://opencode.ai/config.json"
    ) {
      delete (redacted as Record<string, unknown>).$schema
    }
    process.stdout.write(JSON.stringify(redacted, null, 2) + EOL)
  }),
})
