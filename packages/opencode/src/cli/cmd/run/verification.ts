import { EOL } from "node:os"
import type { OpencodeClient } from "@yukioshi/sdk/v2"
import type { Verification } from "@yukioshi/schema/verification"
import {
  discoverProjectCommands,
  detectTurnChangedFiles,
  executeVerificationCommand,
  runVerificationPipeline,
  type FileChangeInput,
  type ProjectCommandInput,
  type VerificationClient,
  type RunVerificationOptions,
} from "@yukioshi/core/verification"

export {
  discoverProjectCommands,
  detectTurnChangedFiles,
  executeVerificationCommand,
  runVerificationPipeline,
  type FileChangeInput,
  type ProjectCommandInput,
  type VerificationClient,
  type RunVerificationOptions,
}

/** Formats verification summary matching main's UX. */
export function formatVerificationOutput(
  summary: Verification.Summary,
  isTTY = process.stdout.isTTY,
): string {
  const statusColor =
    summary.status === "VERIFIED"
      ? "\x1b[92m"
      : summary.status === "FAILED"
        ? "\x1b[91m"
        : "\x1b[93m"

  if (isTTY) {
    return `\x1b[1mVerification:\x1b[0m ${statusColor}${summary.status}\x1b[0m \x1b[90m— ${summary.explanation}\x1b[0m`
  }
  return `Verification: ${summary.status} — ${summary.explanation}`
}

export interface ExecutePostTurnVerificationOptions {
  readonly cwd: string
  readonly client: OpencodeClient
  readonly sessionID: string
  readonly promptResult?: any
  readonly emit?: (type: string, data: Record<string, unknown>) => boolean
  /** --format json: report only through `emit`, never as text lines, so stdout stays one JSON event per line. */
  readonly json?: boolean
  readonly isTTY?: boolean
  readonly out?: (line: string) => void
  readonly skip?: boolean
  readonly commandsOverride?: readonly ProjectCommandInput[]
  readonly changedFilesOverride?: readonly FileChangeInput[]
}

/**
 * Runs the post-turn verification flow: detects changes, plans checks, runs the engine,
 * and prints the status to stdout matching main's UX.
 */
export async function executePostTurnVerification(
  options: ExecutePostTurnVerificationOptions,
): Promise<Verification.Summary> {
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY)
  const out = options.out ?? ((line: string) => process.stdout.write(line + EOL))
  const isFormatted = !options.json

  const summary = await runVerificationPipeline({
    cwd: options.cwd,
    client: options.client,
    sessionID: options.sessionID,
    promptResult: options.promptResult,
    skip: options.skip,
    commandsOverride: options.commandsOverride,
    changedFilesOverride: options.changedFilesOverride,
    onStart: (planned) => {
      if (isFormatted && planned.length > 0) {
        const startLabels = planned.map((c) => c.label).join(", ")
        out(isTTY ? `\x1b[1mVerifying:\x1b[0m ${startLabels}` : `Verifying: ${startLabels}`)
      }
    },
    onCheck: (check) => {
      if (isFormatted) {
        const mark =
          check.status === "passed"
            ? isTTY
              ? "\x1b[92m✔\x1b[0m"
              : "✔"
            : check.status === "skipped"
              ? isTTY
                ? "\x1b[93m–\x1b[0m"
                : "–"
              : isTTY
                ? "\x1b[91m✖\x1b[0m"
                : "✖"
        const dur = Math.round(check.durationMs)
        const dimDetails = isTTY ? `\x1b[90m(${check.status}, ${dur} ms)\x1b[0m` : `(${check.status}, ${dur} ms)`
        out(`  ${mark} ${check.label} ${dimDetails}`)
      }
    },
  })

  if (options.emit) options.emit("verification", { verification: summary })
  if (isFormatted) out(formatVerificationOutput(summary, isTTY))
  return summary
}
