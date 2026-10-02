/**
 * Shared sandbox profile builder for all tools that write to the filesystem.
 *
 * shell.ts, write.ts, and edit.ts all need the same "is this path inside the
 * project's sandbox-allowed tree?" logic. Centralising it here avoids drift
 * between the three sites and makes the policy easy to adjust in one place.
 */
import path from "path"
import type { InstanceContext } from "../project/instance-context"
import type { ConfigSandboxV1 } from "@yukioshi/core/v1/config/sandbox"
import * as Sandbox from "@yukioshi/sandbox"
import { Path as GlobalPath } from "@yukioshi/core/global"
import { Effect } from "effect"

/**
 * Build the static `Sandbox.Profile` for the given instance and config.
 *
 * This is the same profile that `shell.ts` passes to `Sandbox.run()` and
 * `Sandbox.prepareCommand()`.  `write.ts` and `edit.ts` use it to check a
 * resolved filepath against `profile.filesystem.allowWrite` via
 * `Sandbox.assertWrite()` **before** the actual `fs.writeWithDirs()` call.
 *
 * Non-git projects set `worktree` to `"/"` (see `project/instance-context.ts`).
 * Widening the writable root to `"/"` in that case would make everything on
 * disk writable — use `directory` alone instead.
 */
export function sandboxProfile(
  instance: InstanceContext,
  cfg: ConfigSandboxV1.Info | undefined,
): Sandbox.Profile {
  const project =
    instance.directory === instance.worktree || instance.worktree === "/"
      ? [instance.directory]
      : [instance.worktree, instance.directory]

  const writable = [
    ...project,
    GlobalPath.data,
    GlobalPath.cache,
    GlobalPath.config,
    GlobalPath.state,
    GlobalPath.tmp,
    GlobalPath.bin,
    GlobalPath.log,
    GlobalPath.repos,
    ...(cfg?.writablePaths ?? []).map((entry) => resolveWritablePath(entry, project[0])),
  ].map((value) => ({ path: value, kind: "subtree" as const }))

  return {
    filesystem: {
      allowWrite: writable,
      denyWrite: [],
      denyNames: [".git"],
      temporaryDirectory: GlobalPath.tmp,
    },
    network: { mode: cfg?.network ?? "allow", allowedHosts: [] },
    environment: { deny: [], set: {} },
  }
}

/** Expands a leading `~` to the home directory and resolves relative entries against the project root. */
function resolveWritablePath(entry: string, root: string) {
  if (entry === "~") return GlobalPath.home
  if (entry.startsWith("~/") || entry.startsWith("~\\")) return path.join(GlobalPath.home, entry.slice(2))
  return path.resolve(root, entry)
}

/**
 * Validates that `filepath` is permitted by the active sandbox policy.
 *
 * If sandbox is not enabled in `cfg`, this is a no-op.
 * If sandbox is enabled, checks `filepath` against `profile.filesystem.allowWrite`
 * (and denyWrite / denyNames) using `Sandbox.assertWrite()`.
 * Fails with an Error if the path is outside the allowed sandbox write paths.
 */
export function assertSandboxWrite(
  filepath: string,
  instance: InstanceContext,
  cfg: ConfigSandboxV1.Info | undefined,
): Effect.Effect<void> {
  if (!cfg?.enabled) return Effect.void
  const profile = sandboxProfile(instance, cfg)
  return Sandbox.run(profile, Sandbox.assertWrite(filepath)).pipe(
    Effect.mapError((err) => {
      const detail =
        typeof err === "object" && err !== null && "description" in err && typeof err.description === "string"
          ? err.description
          : err instanceof Error
            ? err.message
            : String(err)
      return new Error(`Sandbox denied write access to ${filepath}: ${detail}`)
    }),
    Effect.orDie,
  )
}
