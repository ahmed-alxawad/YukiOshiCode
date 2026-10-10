import { Effect } from "effect"
import { fail } from "./effect-cmd"

/**
 * Commands that open a picker or prompt cannot work with piped or redirected input: they would wait forever.
 * Fail up front and say how to run the command without the prompt.
 */
export const NO_TERMINAL = (what: string, instead: string) =>
  `${what} needs an interactive terminal, but input is not one. ${instead}`

export const requireTerminal = (what: string, instead: string, isTTY: boolean | undefined = process.stdin.isTTY) =>
  isTTY ? Effect.void : fail(NO_TERMINAL(what, instead))
