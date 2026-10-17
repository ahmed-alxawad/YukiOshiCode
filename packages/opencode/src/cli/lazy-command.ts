import type { Argv, CommandModule } from "yargs"

type AnyCommand = CommandModule<any, any>

type LazyCommandOptions = {
  command: string | readonly string[]
  aliases?: string | readonly string[]
  describe?: string | false
  load: () => Promise<unknown>
}

/** Keep command modules out of the startup graph until yargs selects one. */
export function lazyCommand(options: LazyCommandOptions): AnyCommand {
  let loaded: Promise<AnyCommand> | undefined
  const get = () => (loaded ??= options.load().then((command) => command as AnyCommand))

  return {
    command: options.command,
    aliases: options.aliases,
    describe: options.describe,
    builder: async (yargs: Argv) => {
      const command = await get()
      if (!command.builder) return yargs
      if (typeof command.builder === "function") return command.builder(yargs)
      return yargs.options(command.builder)
    },
    handler: async (args) => (await get()).handler?.(args),
  }
}
