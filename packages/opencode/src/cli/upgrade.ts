import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@yukioshi/core/flag/flag"
import { Global } from "@yukioshi/core/global"
import { Flock } from "@yukioshi/core/util/flock"
import { Installation } from "@/installation"
import { AutoUpdate } from "@/installation/auto-update"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { GlobalBus } from "@/bus/global"

async function setting(): Promise<AutoUpdate.AutoupdateSetting> {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  return config.autoupdate
}

function blockedReason(autoupdate: AutoUpdate.AutoupdateSetting, current = InstallationVersion) {
  return AutoUpdate.blocked({
    autoupdate,
    disabledByEnv: Flag.YUKIOSHI_DISABLE_AUTOUPDATE,
    ci: AutoUpdate.isCI(),
    current,
  })
}

function emit(type: string, properties: Record<string, unknown>) {
  GlobalBus.emit("event", { directory: "global", payload: { type, properties } })
}

/** Shows an automatic-update outcome in the TUI with the existing toast and update dialog. */
export function announceInTui(outcome: AutoUpdate.Outcome, current = InstallationVersion) {
  const message = AutoUpdate.noticeText(outcome, current)
  if (outcome.kind === "installed") {
    emit(Installation.Event.Updated.type, { version: outcome.version })
    emit("tui.toast.show", { message, variant: "info", duration: 10_000 })
    return
  }
  if (outcome.kind === "failed") {
    emit("tui.toast.show", { message, variant: "warning", duration: 10_000 })
    return
  }
  // `yukioshi upgrade` can install these itself, so offer the existing "Update Available" dialog.
  if (outcome.method === "curl" && outcome.reason !== "not-writable") {
    emit(Installation.Event.UpdateAvailable.type, { version: outcome.version })
    return
  }
  emit("tui.toast.show", { message, variant: "info", duration: 10_000 })
}

/**
 * Shows the outcome of an earlier background update once, then starts today's background check
 * when one is due. Never waits for the network or the download. With `watch`, an outcome that
 * arrives while this process still runs is shown as soon as the check ends.
 */
async function start(input: { announce: (outcome: AutoUpdate.Outcome) => void; watch: boolean }) {
  const autoupdate = await setting()
  if (blockedReason(autoupdate)) return
  const stateDir = Global.Path.state
  const pending = AutoUpdate.takeNotice(stateDir)
  if (pending) input.announce(pending)
  if (!AutoUpdate.isDue(AutoUpdate.readState(stateDir))) return
  if (!AutoUpdate.isCompiledBinary()) return
  const child = AutoUpdate.spawnBackground()
  if (child && input.watch) {
    child.once("exit", () => {
      const outcome = AutoUpdate.takeNotice(stateDir)
      if (outcome) input.announce(outcome)
    })
  }
}

/** TUI: called by the TUI worker shortly after start. */
export async function upgrade() {
  if (Flag.YUKIOSHI_ALWAYS_NOTIFY_UPDATE) {
    // Development aid: always show the update dialog for the latest release.
    const latest = await Installation.latest(await Installation.method()).catch(() => undefined)
    if (latest) emit(Installation.Event.UpdateAvailable.type, { version: latest })
    return
  }
  await start({ announce: (outcome) => announceInTui(outcome), watch: true })
}

/**
 * `yukioshi run`: one stderr line about an earlier background update, and today's background check.
 * The caller skips this for `--format json`, so JSON output never gets it.
 */
export async function runAutoUpdate(write: (line: string) => void = (line) => process.stderr.write(line + "\n")) {
  await start({ announce: (outcome) => write(AutoUpdate.noticeText(outcome, InstallationVersion)), watch: false })
}

/**
 * The detached background child (`yukioshi upgrade --background`): checks the latest release once,
 * installs it when allowed, and records the outcome for the next start. It prints nothing.
 */
export async function backgroundUpdate(
  // Tests pass these; a real run uses this process's binary, version and detected install method.
  input: { execPath?: string; current?: string; method?: Installation.Method } = {},
) {
  if (!input.execPath && !AutoUpdate.isCompiledBinary()) return
  const execPath = input.execPath ?? process.execPath
  const current = input.current ?? InstallationVersion
  const autoupdate = await setting()
  if (blockedReason(autoupdate, current)) return
  const stateDir = Global.Path.state
  // This process started and is running: if it is the binary the last update installed, it is verified.
  AutoUpdate.markVerified(Global.Path.cache, execPath, current)
  // Another yukioshi process is already checking or installing: leave it to that one.
  const lock = await Flock.acquire(AutoUpdate.LOCK_KEY, { timeoutMs: 0, staleMs: 2 * 60_000 }).catch(() => undefined)
  if (!lock) return
  try {
    const state = AutoUpdate.readState(stateDir)
    if (!AutoUpdate.isDue(state)) return
    const now = Date.now()
    const method = input.method ?? (await Installation.method())
    const latest = await Installation.latest(method).catch(() => undefined)
    if (!latest) {
      // A failed lookup (rate limit, 5xx, offline) must not silence checks for a day: retry in an hour.
      AutoUpdate.writeState(stateDir, {
        ...state,
        checkedAt: now - AutoUpdate.CHECK_INTERVAL_MS + AutoUpdate.RETRY_AFTER_FAILED_CHECK_MS,
      })
      return
    }
    const decision = AutoUpdate.decide({
      current,
      latest,
      autoupdate,
      method,
      writable: AutoUpdate.canReplace(execPath),
    })
    const record = (outcome?: AutoUpdate.Outcome) =>
      AutoUpdate.writeState(stateDir, { checkedAt: now, latest, outcome })

    if (decision.action === "none") return record(undefined)
    if (decision.action === "notify")
      return record({
        kind: "available",
        version: decision.version,
        from: current,
        reason: decision.reason,
        method,
        command: AutoUpdate.upgradeCommand(method, decision.version),
        at: now,
      })

    const failed = (reason: string) =>
      record({ kind: "failed", version: decision.version, from: current, reason, at: now })
    const asset = AutoUpdate.detectAsset()
    if (!asset) return failed(`there is no release build for ${process.platform}-${process.arch}`)
    let warning: string | undefined
    const error = await AutoUpdate.installRelease({
      version: decision.version,
      asset,
      execPath,
      workDir: Global.Path.cache,
      warn: (msg) => {
        warning = msg
      },
    }).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    if (error) return failed(error)
    return record({
      kind: "installed",
      version: decision.version,
      from: current,
      at: now,
      ...(warning ? { warning } : {}),
    })
  } finally {
    await lock.release().catch(() => {})
  }
}
