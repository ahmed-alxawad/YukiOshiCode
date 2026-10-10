import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@yukioshi/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade yukioshi to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`yukioshi is installed to ${process.execPath} and may be managed by a package manager`)
      if (!process.stdin.isTTY) {
        prompts.log.error(
          "YukiOshi could not tell how it was installed, and it cannot ask because input is not a terminal. Name the method with `yukioshi upgrade --method <curl|npm|pnpm|bun|brew|choco|scoop>`, or upgrade with the tool you installed it with.",
        )
        process.exitCode = 1
        return
      }
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest().catch(() => undefined)
    if (!target) {
      prompts.log.error(
        "Could not look up the latest version (no network, or the release server is unreachable). Check your connection and try again, or name a version: `yukioshi upgrade 1.2.3`.",
      )
      process.exitCode = 1
      return
    }

    if (InstallationVersion === target) {
      prompts.log.warn(`yukioshi upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.log.info(
        `Check that version ${target} exists and that you can write to the install location, or pick another method with --method.`,
      )
      prompts.outro("Done")
      process.exitCode = 1
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
