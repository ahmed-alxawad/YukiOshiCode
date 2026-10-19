// Automatic updates: a daily background check that installs newer non-major releases in place.
//
// The check runs in a detached child process (`yukioshi upgrade --background`) so it never delays
// startup and still finishes when a short `yukioshi run` exits first. The child downloads the
// release archive, verifies it against the release's SHA256SUMS, checks that the new binary starts,
// keeps the old binary as `<binary>.old`, and swaps the new one in. A running process keeps using the
// binary it started from, so the new version is used from the next start. The outcome is written to
// `<state>/autoupdate.json`; the next TUI or `run` start (or the TUI that started the check, if it is
// still open) shows it once.
import path from "path"
import fs from "fs"
import fsp from "fs/promises"
import { createHash } from "crypto"
import { spawn, spawnSync } from "child_process"
import semver from "semver"
import type { Method } from "."
import { checkSums } from "./release-key"

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const STATE_FILE = "autoupdate.json"
export const LOCK_KEY = "autoupdate"
const GITHUB_REPOSITORY = "ahmed-alxawad/YukiOshiCode"
const INSTALL_SCRIPT = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/install`
const INSTALL_SCRIPT_PS1 = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/install.ps1`

/**
 * Base URL of the GitHub release pages (`<base>/releases/download/v<version>/<asset>`).
 * Test-only: YUKIOSHI_TEST_RELEASE_BASE_URL points release lookups and downloads at a local fake
 * release server. It is ignored unless set; never set it outside tests.
 */
export function releaseBaseUrl() {
  return (process.env.YUKIOSHI_TEST_RELEASE_BASE_URL || `https://github.com/${GITHUB_REPOSITORY}`).replace(/\/+$/, "")
}

export type AvailableReason = "major" | "notify" | "package-manager" | "unknown-method" | "not-writable" | "prerelease"

export type Outcome =
  | { kind: "installed"; version: string; from: string; at: number; announced?: boolean; warning?: string }
  | {
      kind: "available"
      version: string
      from: string
      reason: AvailableReason
      command: string
      method: Method
      at: number
      announced?: boolean
    }
  | { kind: "failed"; version: string; from: string; reason: string; at: number; announced?: boolean }

export type State = { checkedAt?: number; latest?: string; outcome?: Outcome }

export type Decision =
  | { action: "none"; why: string }
  | { action: "notify"; version: string; reason: AvailableReason }
  | { action: "install"; version: string }

export type AutoupdateSetting = boolean | "notify" | undefined

/** True when the CI environment variable says we run in CI (any value except empty, "0" and "false"). */
export function isCI(env: Record<string, string | undefined> = process.env) {
  const value = env.CI?.trim().toLowerCase()
  return !!value && value !== "0" && value !== "false"
}

/**
 * Why no background check may start at all, or undefined when it may. Checked by the starting process
 * and again by the background child.
 */
export function blocked(input: {
  autoupdate: AutoupdateSetting
  disabledByEnv: boolean
  ci: boolean
  current: string
}): string | undefined {
  if (input.autoupdate === false) return 'the "autoupdate" setting is false'
  if (input.disabledByEnv) return "YUKIOSHI_DISABLE_AUTOUPDATE is set"
  if (input.ci) return "the CI environment variable is set"
  if (!semver.valid(input.current)) return `this build (${input.current}) is not a release`
  return undefined
}

/** A check is due when none has run in the last day (or the clock went backwards). */
export function isDue(state: State, now = Date.now(), interval = CHECK_INTERVAL_MS) {
  if (!state.checkedAt) return true
  if (now < state.checkedAt) return true
  return now - state.checkedAt >= interval
}

/** What to do about the latest release: nothing, tell the user, or install it in the background. */
export function decide(input: {
  current: string
  latest: string
  autoupdate: AutoupdateSetting
  method: Method
  writable: boolean
}): Decision {
  if (!semver.valid(input.current) || !semver.valid(input.latest))
    return { action: "none", why: "not a release version" }
  if (!semver.gt(input.latest, input.current)) return { action: "none", why: "up to date" }
  if (semver.major(input.latest) > semver.major(input.current))
    return { action: "notify", version: input.latest, reason: "major" }
  if (semver.prerelease(input.latest)) return { action: "notify", version: input.latest, reason: "prerelease" }
  if (input.autoupdate === "notify") return { action: "notify", version: input.latest, reason: "notify" }
  if (input.method === "unknown") return { action: "notify", version: input.latest, reason: "unknown-method" }
  if (input.method !== "curl") return { action: "notify", version: input.latest, reason: "package-manager" }
  if (!input.writable) return { action: "notify", version: input.latest, reason: "not-writable" }
  return { action: "install", version: input.latest }
}

/** The command that updates an installation made with `method` to `version`. */
export function upgradeCommand(method: Method, version: string, platform: NodeJS.Platform = process.platform) {
  switch (method) {
    case "npm":
      return `npm install -g yukioshi-ai@${version}`
    case "yarn":
      return `yarn global add yukioshi-ai@${version}`
    case "pnpm":
      return `pnpm install -g yukioshi-ai@${version}`
    case "bun":
      return `bun install -g yukioshi-ai@${version}`
    case "brew":
      return "brew upgrade yukioshi"
    case "scoop":
      return "scoop update yukioshi"
    case "choco":
      return "choco upgrade yukioshi"
    case "curl":
      return "yukioshi upgrade"
    default:
      return platform === "win32" ? `irm ${INSTALL_SCRIPT_PS1} | iex` : `curl -fsSL ${INSTALL_SCRIPT} | bash`
  }
}

/** The one-line message for an outcome, as seen by a process running `current`. */
export function noticeText(outcome: Outcome, current: string) {
  switch (outcome.kind) {
    case "installed": {
      const note = outcome.warning ? ` (${outcome.warning})` : ""
      return outcome.version === current
        ? `YukiOshi was updated to v${outcome.version} automatically${note}.`
        : `YukiOshi v${outcome.version} was installed in the background${note}; it will be used the next time you start yukioshi.`
    }
    case "available": {
      const why =
        outcome.reason === "major"
          ? " (a major version is never installed automatically)"
          : outcome.reason === "not-writable"
            ? ` (cannot replace ${process.execPath} automatically)`
            : ""
      return `YukiOshi v${outcome.version} is available (you have v${outcome.from})${why}. Update with: ${outcome.command}`
    }
    default:
      return `The automatic update to YukiOshi v${outcome.version} failed (${outcome.reason}); still using v${outcome.from}. Run \`yukioshi upgrade\` to try again.`
  }
}

export function statePath(stateDir: string) {
  return path.join(stateDir, STATE_FILE)
}

const str = (value: unknown): value is string => typeof value === "string" && value.length > 0

/** Keeps only well-formed fields, so a damaged or hand-edited state file cannot stop checks or garble notices. */
function sanitizeState(parsed: unknown): State {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const raw = parsed as Record<string, unknown>
  const state: State = {}
  if (typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt)) state.checkedAt = raw.checkedAt
  if (str(raw.latest)) state.latest = raw.latest
  const o = raw.outcome as Record<string, unknown> | null | undefined
  if (o && typeof o === "object" && str(o.version) && str(o.from) && typeof o.at === "number") {
    const base = { version: o.version, from: o.from, at: o.at, ...(o.announced === true ? { announced: true } : {}) }
    if (o.kind === "installed")
      state.outcome = { kind: "installed", ...base, ...(str(o.warning) ? { warning: o.warning } : {}) }
    else if (o.kind === "failed" && str(o.reason)) state.outcome = { kind: "failed", reason: o.reason, ...base }
    else if (o.kind === "available" && str(o.reason) && str(o.command) && str(o.method))
      state.outcome = { kind: "available", reason: o.reason as AvailableReason, command: o.command, method: o.method as Method, ...base }
  }
  return state
}

export function readState(stateDir: string): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(stateDir), "utf8"))
    return sanitizeState(parsed)
  } catch {
    return {}
  }
}

export function writeState(stateDir: string, state: State) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = statePath(stateDir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  fs.renameSync(tmp, file)
}

/** Returns the outcome that has not been shown yet and marks it shown, so it is shown only once. */
export function takeNotice(stateDir: string): Outcome | undefined {
  const state = readState(stateDir)
  const outcome = state.outcome
  if (!outcome || outcome.announced) return undefined
  try {
    writeState(stateDir, { ...state, outcome: { ...outcome, announced: true } })
  } catch {
    // A state dir we cannot write would repeat the notice on every start; better to say nothing.
    return undefined
  }
  return outcome
}

/** True when this process may replace its own binary: both the file and its folder are writable. */
export function canReplace(execPath: string) {
  try {
    fs.accessSync(path.dirname(execPath), fs.constants.W_OK)
    fs.accessSync(execPath, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The release archive name for a platform, matching the names the `install` script downloads. */
export function assetName(input: { platform: NodeJS.Platform; arch: string; musl: boolean; baseline: boolean }) {
  const os = input.platform === "win32" ? "windows" : input.platform
  if (os !== "linux" && os !== "darwin" && os !== "windows") return undefined
  if (input.arch !== "x64" && input.arch !== "arm64") return undefined
  let target = `${os}-${input.arch}`
  if (input.baseline && input.arch === "x64") target += "-baseline"
  if (input.musl && os === "linux") target += "-musl"
  return `yukioshi-${target}${os === "linux" ? ".tar.gz" : ".zip"}`
}

function commandOutput(cmd: string, args: string[]) {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 })
    return `${result.stdout ?? ""}${result.stderr ?? ""}`
  } catch {
    return ""
  }
}

/** The release archive for this machine, detected the same way the `install` script does. */
export function detectAsset() {
  const platform = process.platform
  let arch: string = process.arch
  if (
    platform === "darwin" &&
    arch === "x64" &&
    commandOutput("sysctl", ["-n", "sysctl.proc_translated"]).trim() === "1"
  )
    arch = "arm64"
  let musl = false
  if (platform === "linux") {
    musl = fs.existsSync("/etc/alpine-release") || /musl/i.test(commandOutput("ldd", ["--version"]))
  }
  let baseline = false
  if (arch === "x64" && platform === "linux") {
    try {
      baseline = !/\bavx2\b/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {}
  }
  if (arch === "x64" && platform === "darwin")
    baseline = commandOutput("sysctl", ["-n", "hw.optional.avx2_0"]).trim() !== "1"
  return assetName({ platform, arch, musl, baseline })
}

/** The SHA-256 listed for `asset` in a SHA256SUMS file, or undefined when it is not listed. */
export function checksumFor(sums: string, asset: string) {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match && match[2].trim() === asset) return match[1].toLowerCase()
  }
  return undefined
}

export class UpdateError extends Error {}

async function download(fetcher: typeof fetch, url: string, timeoutMs: number) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" }).catch(
    (error: unknown) => {
      throw new UpdateError(`could not download ${url}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  if (!response.ok) throw new UpdateError(`could not download ${url} (HTTP ${response.status})`)
  return response
}

const GIB = 1024 * 1024 * 1024

/** The largest archive accepted: 1 GiB, or 3x the current binary when that is known (but at least 64 MiB). */
export function downloadLimit(previousSize?: number) {
  if (!previousSize) return GIB
  return Math.min(GIB, Math.max(3 * previousSize, 64 * 1024 * 1024))
}

/** Reads a response body, aborting as soon as it grows past `limit` bytes instead of after it is all in memory. */
async function readLimited(response: Response, limit: number, name: string) {
  const tooBig = () =>
    new UpdateError(`${name} is larger than the ${Math.round(limit / 1024 / 1024)} MiB limit for an update download; refusing it`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {})
    throw tooBig()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  for (;;) {
    const { done, value } = await reader.read().catch((error: unknown) => {
      throw new UpdateError(`the download of ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (done) break
    total += value.byteLength
    if (total > limit) {
      void reader.cancel().catch(() => {})
      throw tooBig()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export type SwapOps = {
  link: (existing: string, target: string) => Promise<void>
  copyFile: (from: string, to: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  rm: (target: string) => Promise<void>
}

const realOps: SwapOps = {
  link: (a, b) => fsp.link(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  rename: (a, b) => fsp.rename(a, b),
  rm: (a) => fsp.rm(a, { force: true }),
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Removes backups a running Windows process kept from being deleted earlier; failures are ignored. */
export async function cleanStaleBackups(execPath: string, ops: Partial<SwapOps> = {}) {
  const rm = ops.rm ?? realOps.rm
  const dir = path.dirname(execPath)
  const prefix = `${path.basename(execPath)}.old.`
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  for (const name of names) if (name.startsWith(prefix)) await rm(path.join(dir, name)).catch(() => {})
}

/**
 * Puts `staged` in place of `execPath`, keeping the previous binary as `<execPath>.old`.
 * Linux and macOS: the backup is a hard link (or copy) made first, then the new binary is renamed
 * over `execPath` in a single atomic rename, so `execPath` always exists and always works.
 * Windows cannot rename over a running exe, so the old one is moved aside first; if putting the new
 * one in place fails it is moved back, and if that fails too the error says how to restore it.
 */
export async function swapBinary(input: { execPath: string; staged: string; windows: boolean; ops?: Partial<SwapOps> }) {
  const ops = { ...realOps, ...input.ops }
  const { execPath, staged } = input
  let backup = `${execPath}.old`
  if (!input.windows) {
    await ops.rm(backup).catch(() => {})
    await ops.link(execPath, backup).catch(() => ops.copyFile(execPath, backup)).catch((error: unknown) => {
      throw new UpdateError(`could not keep a backup of the current binary: ${message(error)}`)
    })
    await ops.rename(staged, execPath).catch((error: unknown) => {
      throw new UpdateError(`could not put the new binary in place: ${message(error)}`)
    })
    return
  }
  // The old backup may be a binary that is still running; Windows then refuses to delete it. Skip it
  // (it is cleaned up at the next update) and use a name of its own.
  let stuck = false
  await ops.rm(backup).catch(() => {
    stuck = true
  })
  if (stuck || fs.existsSync(backup)) backup = `${execPath}.old.${process.pid}`
  await ops.rename(execPath, backup).catch((error: unknown) => {
    throw new UpdateError(`could not move the current binary aside: ${message(error)}`)
  })
  await ops.rename(staged, execPath).catch(async (error: unknown) => {
    const restored = await ops.rename(backup, execPath).then(
      () => true,
      () => false,
    )
    throw new UpdateError(
      `could not put the new binary in place: ${message(error)}` +
        (restored ? "" : `; to go back, rename ${backup} to ${execPath}`),
    )
  })
}

/**
 * Downloads release `version`, verifies it against SHA256SUMS, checks that the new binary starts and
 * reports `version`, then replaces `execPath` with it and keeps the previous binary as `<execPath>.old`.
 * Throws UpdateError and leaves `execPath` untouched on any failure before the swap.
 */
export async function installRelease(input: {
  version: string
  asset: string
  execPath: string
  workDir: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  ops?: Partial<SwapOps>
  /** Overrides the embedded release key and signing cutoff (tests). */
  signing?: { key?: string; requiredFrom?: string }
  /** Called with a note when the release is allowed without a signature. */
  warn?: (message: string) => void
}) {
  const fetcher = input.fetch ?? fetch
  const timeoutMs = input.timeoutMs ?? 10 * 60_000
  const base = `${input.baseUrl ?? releaseBaseUrl()}/releases/download/v${input.version}`
  const windows = input.asset.startsWith("yukioshi-windows-")
  await cleanStaleBackups(input.execPath, input.ops)

  const sumsResponse = await download(fetcher, `${base}/SHA256SUMS`, timeoutMs).catch((error: unknown) => {
    throw new UpdateError(
      `the release has no SHA256SUMS to verify the download with (${error instanceof Error ? error.message : String(error)})`,
    )
  })
  const sumsBytes = new Uint8Array(await sumsResponse.arrayBuffer())
  const sigResponse = await fetcher(`${base}/SHA256SUMS.sig`, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" }).catch(
    (error: unknown) => {
      throw new UpdateError(`could not download ${base}/SHA256SUMS.sig: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  if (!sigResponse.ok && sigResponse.status !== 404)
    throw new UpdateError(`could not download ${base}/SHA256SUMS.sig (HTTP ${sigResponse.status})`)
  try {
    const check = checkSums({
      sums: sumsBytes,
      signature: sigResponse.ok ? await readLimited(sigResponse, 4096, "SHA256SUMS.sig") : undefined,
      version: input.version,
      ...input.signing,
    })
    if (check === "unsigned-allowed") input.warn?.("this release has no SHA256SUMS.sig; installing it unsigned")
  } catch (error) {
    throw new UpdateError(error instanceof Error ? error.message : String(error))
  }
  const expected = checksumFor(new TextDecoder().decode(sumsBytes), input.asset)
  if (!expected) throw new UpdateError(`${input.asset} is not listed in the release's SHA256SUMS`)

  const previousSize = await fsp.stat(input.execPath).then(
    (stat) => stat.size,
    () => undefined,
  )
  const limit = input.maxBytes ?? downloadLimit(previousSize)
  const archive = await readLimited(await download(fetcher, `${base}/${input.asset}`, timeoutMs), limit, input.asset)
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected) throw new UpdateError(`${input.asset} does not match its SHA256SUMS checksum`)

  await fsp.mkdir(input.workDir, { recursive: true })
  const tmp = await fsp.mkdtemp(path.join(input.workDir, "update-"))
  const binDir = path.dirname(input.execPath)
  const staged = path.join(binDir, `.yukioshi.new.${process.pid}${windows ? ".exe" : ""}`)
  try {
    const archivePath = path.join(tmp, input.asset)
    await fsp.writeFile(archivePath, archive)
    const extractDir = path.join(tmp, "out")
    await fsp.mkdir(extractDir)
    // GNU tar on Linux reads the .tar.gz; macOS and Windows ship bsdtar, which also reads the .zip.
    const tar = spawnSync("tar", [input.asset.endsWith(".tar.gz") ? "-xzf" : "-xf", archivePath, "-C", extractDir], {
      encoding: "utf8",
      timeout: 120_000,
    })
    if (tar.error || tar.status !== 0)
      throw new UpdateError(`could not unpack ${input.asset}: ${(tar.error?.message ?? tar.stderr ?? "").trim()}`)
    const extracted = path.join(extractDir, windows ? "yukioshi.exe" : "yukioshi")
    if (!fs.existsSync(extracted)) throw new UpdateError(`${input.asset} does not contain a yukioshi binary`)

    await fsp.copyFile(extracted, staged)
    await fsp.chmod(staged, 0o755)
    const check = spawnSync(staged, ["--version"], { encoding: "utf8", timeout: 60_000 })
    const reported = (check.stdout ?? "").trim()
    if (check.error || check.status !== 0 || reported !== input.version)
      throw new UpdateError(
        `the new binary failed its start check (expected ${input.version}, got ${JSON.stringify(reported || check.error?.message || `exit ${check.status}`)})`,
      )

    await swapBinary({ execPath: input.execPath, staged, windows, ops: input.ops })
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => {})
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * True when this process is a compiled yukioshi binary, whose files live in Bun's embedded file
 * system. A source checkout (`bun src/index.ts`) is not: its process.execPath is Bun itself, which
 * must never be replaced or run as `bun upgrade`.
 */
export function isCompiledBinary(main: string = Bun.main) {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main)
}

/**
 * Starts the background check as a detached child process of this binary. Returns the child, or
 * undefined when it could not be started. Only compiled release binaries run this.
 */
export function spawnBackground(execPath = process.execPath) {
  try {
    const child = spawn(execPath, ["upgrade", "--background"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.on("error", () => {})
    child.unref()
    return child
  } catch {
    return undefined
  }
}

export * as AutoUpdate from "./auto-update"
