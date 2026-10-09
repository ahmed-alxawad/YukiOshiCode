import { Context, Effect, PlatformError } from "effect"
import { canonicalize, canonicalizeEntry, hasDeniedName, matches, normalize } from "./path"
import type { Profile } from "./profile"
import { withProxy } from "./proxy"

export const CurrentProfile = Context.Reference<Profile | undefined>("@yukioshi/sandbox/CurrentProfile", {
  defaultValue: () => undefined,
})

export const current: Effect.Effect<Profile | undefined> = Effect.gen(function* () {
  return yield* CurrentProfile
})

export const enabled: Effect.Effect<boolean> = Effect.map(current, (profile) => profile !== undefined)

export function run<A, E, R>(
  profile: Profile,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R> {
  return Effect.gen(function* () {
    const value = yield* normalize(profile)
    return yield* withProxy(value, effect.pipe(Effect.provideService(CurrentProfile, value)))
  })
}

export function unrestricted<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.provideService(CurrentProfile, undefined))
}

function denied(path: string, method: string) {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "Sandbox denied write access",
  })
}

function assertTarget(
  path: string,
  method: string,
  resolve: (path: string) => Effect.Effect<string, PlatformError.PlatformError>,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const profile = yield* current
    if (!profile) return
    const target = yield* resolve(path)
    if (
      profile.filesystem.denyWrite.some((rule) => matches(rule, target)) ||
      hasDeniedName(target, profile.filesystem.denyNames)
    ) {
      yield* Effect.fail(denied(path, method))
    }
    if (!profile.filesystem.allowWrite.some((rule) => matches(rule, target))) {
      yield* Effect.fail(denied(path, method))
    }
  })
}

export function assertPath(path: string, method: string): Effect.Effect<void, PlatformError.PlatformError> {
  return assertTarget(path, method, canonicalize)
}

export function assertEntry(path: string, method: string): Effect.Effect<void, PlatformError.PlatformError> {
  return assertTarget(path, method, canonicalizeEntry)
}

export function assertWrite(path: string): Effect.Effect<void, PlatformError.PlatformError> {
  return assertPath(path, "assertWrite")
}
