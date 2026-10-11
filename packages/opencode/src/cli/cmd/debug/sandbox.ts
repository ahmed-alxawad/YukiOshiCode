import { Effect } from "effect"
import { sandboxStatus } from "@yukioshi/sandbox"
import { effectCmd } from "../../effect-cmd"

/** What happens to a shell command given the platform and the `sandbox.enabled` setting. */
export function sandboxEffect(available: boolean, enabled: boolean, platform: NodeJS.Platform) {
  if (enabled && available) return "shell commands run inside the OS sandbox"
  if (enabled) return "shell commands are refused (the sandbox is on but cannot run here)"
  if (platform === "win32") return "shell commands run without an OS sandbox; permission rules and review mode still apply"
  return available
    ? "shell commands run without an OS sandbox (set sandbox.enabled to true to confine them)"
    : "shell commands run without an OS sandbox"
}

export const SandboxCommand = effectCmd({
  command: "sandbox",
  describe: "show whether the OS sandbox can run on this machine, and what that means for shell commands",
  builder: (yargs) =>
    yargs.option("format", { describe: "output format", type: "string", choices: ["text", "json"], default: "text" }),
  handler: Effect.fn("Cli.debug.sandbox")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const status = sandboxStatus()
    const enabled = config.sandbox?.enabled === true
    const effect = sandboxEffect(status.available, enabled, status.platform)
    if (args.format === "json") {
      process.stdout.write(
        JSON.stringify({ platform: status.platform, available: status.available, enabled, status: status.summary, effect }, null, 2) + "\n",
      )
      return
    }
    console.log(`platform: ${status.platform}`)
    console.log(`sandbox: ${status.summary}`)
    console.log(`sandbox.enabled: ${enabled}`)
    console.log(`effect: ${effect}`)
  }),
})
