import { Effect, PlatformError, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { bubblewrap } from "./bubblewrap"
import { current } from "./context"
import { assertProcessNetwork, networkEnvironment } from "./network"
import type { Profile } from "./profile"
import { seatbelt } from "./seatbelt"
import { currentProxy, type ProxyRuntime } from "./proxy"

export interface Launch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly shell?: boolean | string | undefined
}

export interface Support {
  readonly available: boolean
  readonly reason?: string | undefined
}

export interface Backend {
  readonly support: (network?: Profile["network"]) => Support
  readonly prepare: (
    profile: Profile,
    launch: Launch,
    proxy?: ProxyRuntime,
  ) => Effect.Effect<Launch, PlatformError.PlatformError, Scope.Scope>
}

export const WINDOWS_REASON =
  "The OS sandbox is not available on Windows, so shell commands cannot be confined and are refused while sandbox.enabled is true. " +
  "Set sandbox.enabled to false to run them without an OS sandbox, and rely on permission rules and review mode instead."

function unavailable(reason: string): Backend {
  return {
    support: () => ({ available: false, reason }),
    prepare: (_profile, launch) => Effect.succeed(launch),
  }
}

export function select(platform: NodeJS.Platform = process.platform): Backend {
  switch (platform) {
    case "darwin":
      return seatbelt
    case "linux":
      return bubblewrap
    case "win32":
      return unavailable(WINDOWS_REASON)
    default:
      return unavailable("No sandbox backend is available for this operating system")
  }
}

const backend = select()

export interface Status {
  readonly platform: NodeJS.Platform
  readonly available: boolean
  /** One line for `yukioshi debug sandbox`. */
  readonly summary: string
}

/** What the sandbox can do on a platform, in words a person can act on. The platform can be injected for tests. */
export function status(platform: NodeJS.Platform = process.platform, selected: Backend = select(platform)): Status {
  const support = selected.support()
  if (platform === "win32") {
    return {
      platform,
      available: false,
      summary:
        "not available on Windows: shell commands run without OS sandbox; use permission rules/review mode " +
        "(with sandbox.enabled: true they are refused instead)",
    }
  }
  if (platform === "linux") {
    return support.available
      ? { platform, available: true, summary: "available: bubblewrap found and working" }
      : {
          platform,
          available: false,
          summary: `bubblewrap missing or unusable: ${support.reason ?? "unknown reason"}. Install it (Debian/Ubuntu: apt install bubblewrap; Fedora: dnf install bubblewrap; Arch: pacman -S bubblewrap)`,
        }
  }
  if (platform === "darwin") {
    return support.available
      ? { platform, available: true, summary: "available: sandbox-exec found" }
      : { platform, available: false, summary: `sandbox-exec missing: ${support.reason ?? "unknown reason"}` }
  }
  return { platform, available: false, summary: support.reason ?? "no sandbox backend for this operating system" }
}

function environment(profile: Profile, launch: Launch, proxy?: ProxyRuntime) {
  const source = { ...launch.environment, ...profile.environment.set }
  const denied = new Set(profile.environment.deny)
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !denied.has(entry[0]),
  )
  return networkEnvironment(profile, Object.fromEntries(entries), proxy)
}

export function prepare(launch: Launch) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return launch
    const proxy = yield* currentProxy
    const next = { ...launch, environment: environment(profile, launch, proxy) }
    yield* assertProcessNetwork(profile, launch.command)
    const support = backend.support(profile.network)
    if (!support.available) return yield* Effect.fail(unsupported(launch.command, "prepare", support))
    return yield* backend.prepare(profile, next, proxy)
  })
}

function unsupported(command: string, method: string, support: Support) {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "Sandbox",
    method,
    pathOrDescriptor: command,
    description: support.reason ?? "The process sandbox backend is unavailable",
  })
}

export function confine(profile: Profile, launch: Launch) {
  return confineWith(backend, profile, launch)
}

/** `confine` against a chosen backend, so the refusal on an unsupported platform can be tested anywhere. */
export function confineWith(selected: Backend, profile: Profile, launch: Launch) {
  return Effect.gen(function* () {
    const proxy = yield* currentProxy
    const next = { ...launch, environment: environment(profile, launch, proxy) }
    yield* assertProcessNetwork(profile, launch.command)
    const support = selected.support(profile.network)
    if (!support.available) return yield* Effect.fail(unsupported(launch.command, "confine", support))
    return yield* selected.prepare(profile, next, proxy)
  })
}

export function prepareCommand(
  command: ChildProcess.StandardCommand,
  cwd: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
) {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return command
    const launch = yield* confine(profile, {
      command: command.command,
      args: command.args,
      cwd,
      environment: env,
      shell: command.options.shell,
    })
    return ChildProcess.make(launch.command, launch.args, {
      ...command.options,
      cwd: launch.cwd,
      env: launch.environment,
      extendEnv: false,
      shell: false,
    })
  })
}

export function backendSupport(network?: Profile["network"]) {
  return backend.support(network)
}
