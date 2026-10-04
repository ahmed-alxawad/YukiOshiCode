import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"

// The GitHub agent inherited from opencode exchanges the repository's GitHub token at opencode's servers
// and relies on opencode's GitHub App and an action YukiOshi does not publish. Until YukiOshi has its
// own, both commands stop instead of sending repository credentials to a third party.
const UNAVAILABLE =
  "The GitHub agent is not available in YukiOshi Code yet: it needs YukiOshi's own GitHub App and action. " +
  "Use `yukioshi run` in your own workflow instead."

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  handler: () => fail(UNAVAILABLE),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      }),
  handler: () => fail(UNAVAILABLE),
})

export const GithubCommand = cmd({
  command: "github",
  // Hidden from --help while unavailable.
  describe: false,
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
