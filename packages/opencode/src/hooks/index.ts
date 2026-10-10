import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Shell } from "@yukioshi/core/shell"
import { Redact } from "@yukioshi/core/redact"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import { Context, Effect, Exit, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export type EventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "Notification"

const CONFIG_KEYS: Readonly<Record<EventName, keyof ConfigHooksV1.Info>> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  UserPromptSubmit: "userPromptSubmit",
  SessionStart: "sessionStart",
  Stop: "stop",
  SubagentStop: "subagentStop",
  PreCompact: "preCompact",
  Notification: "notification",
}

export interface Result {
  /** Set when a hook blocked (exit code 2, or JSON {"decision":"block"}): the reason to show or send to the model. */
  readonly blocked?: string
  /** Standard output of successful UserPromptSubmit/SessionStart hooks, added as context. */
  readonly context: readonly string[]
  /** Hooks that failed without blocking (other exit codes, timeouts, launch errors). */
  readonly warnings: readonly string[]
  readonly ran: number
}

const EMPTY: Result = { context: [], warnings: [], ran: 0 }
const MAX_OUTPUT = 16_000
// Model/provider API keys and other credentials in the environment are never passed to hook commands.
const HIDDEN_ENV_PATTERN =
  /(_API_KEY|_TOKEN|_SECRET|_SECRET_KEY|_SECRET_ACCESS_KEY|_ACCESS_KEY|_PRIVATE_KEY|_PASSWORD|_PASSWD)$|^(PASSWORD|PASSWD|DATABASE_URL)$/i

export interface RunInput {
  readonly hooks: ConfigHooksV1.Info | undefined
  readonly event: EventName
  readonly payload: Record<string, unknown>
  readonly cwd: string
  readonly shell?: string
  readonly toolName?: string
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly has: (hooks: ConfigHooksV1.Info | undefined, event: EventName) => boolean
  readonly run: (input: RunInput) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@yukioshi/Hooks") {}

/** Compiles a matcher; undefined when it is not a valid regular expression. */
function compile(matcher: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${matcher})$`)
  } catch {
    return undefined
  }
}

// An invalid matcher is reported once per hook, not on every tool call.
const reportedInvalid = new Set<string>()

/**
 * Whether the hook applies to this tool. An invalid matcher fails closed for PreToolUse (the hook is the
 * guard, so it runs for every tool call) and skips the hook for other events; both log a warning once.
 */
function matches(event: EventName, hook: ConfigHooksV1.HookCommand, toolName: string | undefined): Effect.Effect<boolean> {
  const matcher = hook.matcher
  if (!matcher || matcher === "*" || toolName === undefined) return Effect.succeed(true)
  const regex = compile(matcher)
  if (regex) return Effect.succeed(regex.test(toolName))
  const failClosed = event === "PreToolUse"
  const key = `${event}\0${matcher}\0${hook.command}`
  const warn = reportedInvalid.has(key)
    ? Effect.void
    : Effect.sync(() => void reportedInvalid.add(key)).pipe(
        Effect.andThen(
          Effect.logWarning(
            failClosed
              ? "hook matcher is not a valid regular expression; the hook will run for every tool call"
              : "hook matcher is not a valid regular expression; the hook is skipped",
            { event, matcher, command: hook.command },
          ),
        ),
      )
  return warn.pipe(Effect.as(failClosed))
}

interface Decision {
  decision?: string
  reason?: string
  additionalContext?: string
}

/** Claude Code style JSON output: {"decision":"block","reason":"..."} or {"additionalContext":"..."}. */
function parseDecision(stdout: string): Decision | undefined {
  if (!stdout.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    const nested = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>
    const decision =
      typeof parsed.decision === "string"
        ? parsed.decision
        : typeof nested.permissionDecision === "string" && nested.permissionDecision === "deny"
          ? "block"
          : undefined
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason
        : typeof nested.permissionDecisionReason === "string"
          ? nested.permissionDecisionReason
          : undefined
    const additionalContext =
      typeof nested.additionalContext === "string"
        ? nested.additionalContext
        : typeof parsed.additionalContext === "string"
          ? parsed.additionalContext
          : undefined
    return {
      ...(decision ? { decision } : {}),
      ...(reason ? { reason } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    }
  } catch {
    return undefined
  }
}

function hiddenEnv(): Record<string, string> {
  const hidden: Record<string, string> = {}
  for (const key of Object.keys(process.env)) {
    if (HIDDEN_ENV_PATTERN.test(key)) hidden[key] = ""
  }
  return hidden
}

type SpawnOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "abort" }
  | { kind: "error" }

function spawnHook(input: {
  command: string
  shell: string
  cwd: string
  event: EventName
  stdin: string
  timeoutMs: number
  signal?: AbortSignal
}): Effect.Effect<SpawnOutcome, never, ChildProcessSpawner> {
  return Effect.gen(function* () {
    const command = Shell.ps(input.shell)
      ? `${input.command}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`
      : input.command
    const handle = yield* ChildProcess.make(command, [], {
      shell: input.shell,
      cwd: input.cwd,
      env: { ...hiddenEnv(), YUKIOSHI_PROJECT_DIR: input.cwd, YUKIOSHI_HOOK_EVENT: input.event },
      extendEnv: true,
      stdin: Stream.succeed(new TextEncoder().encode(input.stdin)),
      // Leave `detached` at the spawner default (own process group on POSIX) so kill() takes down
      // the whole group (negative pid; taskkill /T on Windows), not just the shell.
    })

    const abort = input.signal
      ? Effect.callback<SpawnOutcome>((resume) => {
          if (input.signal!.aborted) return resume(Effect.succeed({ kind: "abort" }))
          const handler = () => resume(Effect.succeed({ kind: "abort" }))
          input.signal!.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => input.signal!.removeEventListener("abort", handler))
        })
      : undefined

    const exit = Effect.all(
      [
        handle.exitCode,
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([code, stdout, stderr]): SpawnOutcome => ({ kind: "exit", code: Number(code), stdout, stderr })),
    )
    const timeout = Effect.sleep(`${input.timeoutMs} millis`).pipe(Effect.map((): SpawnOutcome => ({ kind: "timeout" })))

    const outcome = yield* Effect.raceAll(abort ? [exit, timeout, abort] : [exit, timeout])
    if (outcome.kind !== "exit") yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
    return outcome
  }).pipe(
    // Hooks that never read stdin (most of them - a formatter, a notifier) can cause an EPIPE
    // on our stdin write once they exit; that surfaces as a defect, not a typed failure, so
    // Effect.exit (not Effect.catch, which only sees the typed channel) is required to catch it.
    Effect.scoped,
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : ({ kind: "error" as const } satisfies SpawnOutcome))),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const has: Interface["has"] = (hooks, event) => ((hooks?.[CONFIG_KEYS[event]] as unknown[] | undefined)?.length ?? 0) > 0

    const run: Interface["run"] = (input) =>
      Effect.gen(function* () {
        const commands = yield* Effect.filter(
          (input.hooks?.[CONFIG_KEYS[input.event]] as ReadonlyArray<ConfigHooksV1.HookCommand> | undefined) ?? [],
          (hook) => matches(input.event, hook, input.toolName),
        )
        if (commands.length === 0) return EMPTY

        const shell = input.shell ?? Shell.acceptable()
        // The payload carries the prompt and tool input/output; credentials in it are masked.
        const stdin = JSON.stringify(Redact.maskDeep({ hook_event_name: input.event, cwd: input.cwd, ...input.payload }))
        const context: string[] = []
        const warnings: string[] = []
        let blocked: string | undefined

        for (const hook of commands) {
          const outcome = yield* spawnHook({
            command: hook.command,
            shell,
            cwd: input.cwd,
            event: input.event,
            stdin,
            timeoutMs: hook.timeoutMs ?? 60_000,
            signal: input.signal,
          })

          if (outcome.kind === "error") {
            warnings.push(`${input.event} hook could not start: ${hook.command}`)
            continue
          }
          if (outcome.kind === "timeout") {
            warnings.push(`${input.event} hook timed out: ${hook.command}`)
            continue
          }
          if (outcome.kind === "abort") break

          const stdout = outcome.stdout.trim().slice(0, MAX_OUTPUT)
          const stderr = outcome.stderr.trim().slice(0, MAX_OUTPUT)
          if (outcome.code === 2) {
            blocked = stderr || stdout || `Blocked by a ${input.event} hook.`
            break
          }
          if (outcome.code !== 0) {
            warnings.push(`${input.event} hook exited with code ${outcome.code}: ${stderr.split("\n")[0] ?? hook.command}`)
            continue
          }
          const decision = parseDecision(stdout)
          if (decision?.decision === "block") {
            blocked = decision.reason || `Blocked by a ${input.event} hook.`
            break
          }
          if (decision?.additionalContext) context.push(decision.additionalContext)
          else if (stdout && !decision && (input.event === "UserPromptSubmit" || input.event === "SessionStart"))
            context.push(stdout)
        }

        // What a hook printed goes to the model and the screen: mask it like any other tool output.
        const safe = (text: string) => Redact.scrubKnown(Redact.mask(text))
        return {
          ...(blocked ? { blocked: safe(blocked) } : {}),
          context: context.map(safe),
          warnings: warnings.map(safe),
          ran: commands.length,
        }
      }).pipe(Effect.provideService(ChildProcessSpawner, spawner))

    return Service.of({ has, run })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [CrossSpawnSpawner.node] })

export * as Hooks from "."
