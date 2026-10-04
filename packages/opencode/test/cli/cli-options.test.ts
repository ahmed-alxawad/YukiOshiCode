import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("CLI options and commands", () => {
  cliIt.concurrent(
    "yukioshi run --agent with an unknown agent exits 1 and prints available agents",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--agent", "nonexistent-agent", "hi"])
        opencode.expectExit(result, 1, "run --agent nonexistent-agent")
        expect(result.stderr).toContain(
          'Agent not found: "nonexistent-agent". Available: build, plan, goal, reasoning, research, auto',
        )
      }),
    60_000,
  )

  cliIt.concurrent(
    "yukioshi run --agent with a subagent exits 1 instead of running in another mode",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--agent", "explore", "hi"])
        opencode.expectExit(result, 1, "run --agent explore")
        expect(result.stderr).toContain('Only other agents can start this subagent: "explore".')
      }),
    60_000,
  )

  cliIt.concurrent(
    "yukioshi completion --help and -h print usage starting with yukioshi completion and exit 0",
    ({ opencode }) =>
      Effect.gen(function* () {
        const help = yield* opencode.spawn(["completion", "--help"])
        opencode.expectExit(help, 0, "completion --help")
        expect(help.stdout.startsWith("yukioshi completion")).toBe(true)

        const shortHelp = yield* opencode.spawn(["completion", "-h"])
        opencode.expectExit(shortHelp, 0, "completion -h")
        expect(shortHelp.stdout.startsWith("yukioshi completion")).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "yukioshi completion prints the shell completion script containing get-yargs-completions",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["completion"])
        opencode.expectExit(result, 0, "completion")
        expect(result.stdout).toContain("get-yargs-completions")
      }),
    60_000,
  )

  cliIt.concurrent(
    "yukioshi run --help lists --verify and --skip-verify",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--help"])
        opencode.expectExit(result, 0, "run --help")
        const helpOutput = result.stderr + "\n" + result.stdout
        expect(helpOutput).toContain("--verify")
        expect(helpOutput).toContain("--skip-verify")
      }),
    60_000,
  )
})
