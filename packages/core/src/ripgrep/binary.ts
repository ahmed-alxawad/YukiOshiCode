import path from "path"
import nodeFs from "node:fs"
import crypto from "node:crypto"
import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  export const VERSION = "15.1.0"
  export const PLATFORM = {
    "arm64-darwin": {
      platform: "aarch64-apple-darwin",
      extension: "tar.gz",
      sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    },
    "x64-darwin": {
      platform: "x86_64-apple-darwin",
      extension: "tar.gz",
      sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    },
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
      sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    },
    "x64-linux": {
      platform: "x86_64-unknown-linux-musl",
      extension: "tar.gz",
      sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    },
    "arm64-win32": {
      platform: "aarch64-pc-windows-msvc",
      extension: "zip",
      sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    },
    "ia32-win32": {
      platform: "i686-pc-windows-msvc",
      extension: "zip",
      sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
    },
    "x64-win32": {
      platform: "x86_64-pc-windows-msvc",
      extension: "zip",
      sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    },
  } as const

  export const DOWNLOAD_TIMEOUT_MS = 60_000

  export const isAllowedHost = (u: URL): boolean => {
    if (u.protocol !== "https:") return false
    const host = u.hostname.toLowerCase()
    return (
      host === "github.com" ||
      host.endsWith(".github.com") ||
      host === "githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    )
  }

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@yukioshi/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dataBin = path.join(Global.Path.data, "bin")
        const dir = yield* fs.makeTempDirectoryScoped({ directory: dataBin, prefix: "ripgrep-" })

        if (config.extension === "zip") {
          const shell = (yield* Effect.sync(() => which("powershell.exe") ?? which("pwsh.exe"))) ?? "powershell.exe"
          const result = yield* run(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`,
          ])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        if (config.extension === "tar.gz") {
          const result = yield* run("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* fs.copyFile(extracted, target)
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      return Service.of({
        // Any problem while locating/downloading/verifying/extracting ripgrep must surface as a typed
        // failure (never a defect) so callers can fall back to the built-in search.
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const dataBin = path.join(Global.Path.data, "bin")
            const target = path.join(dataBin, process.platform === "win32" ? "rg.exe" : "rg")

            const system = yield* Effect.sync(() => {
              const found = which("rg") ?? (process.platform === "win32" ? which("rg.exe") : null)
              if (found) return found
              if (nodeFs.existsSync(target)) return target
              const cacheBin = path.join(Global.Path.bin, process.platform === "win32" ? "rg.exe" : "rg")
              if (nodeFs.existsSync(cacheBin)) return cacheBin
              if (process.platform === "win32") {
                const choco = "C:\\ProgramData\\chocolatey\\bin\\rg.exe"
                if (nodeFs.existsSync(choco)) return choco
              }
              return null
            })
            if (system && (yield* fs.isFile(system).pipe(Effect.orElseSucceed(() => false)))) return system

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            const archive = path.join(dataBin, filename)

            yield* Effect.logInfo("downloading ripgrep", { url, sha256: config.sha256 })
            yield* fs.ensureDir(dataBin).pipe(Effect.orDie)

            const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
            let currentUrl = new URL(url)
            let hops = 0
            let finalResponse: Response | null = null

            while (hops < 5) {
              if (!isAllowedHost(currentUrl)) {
                throw new Error(`ripgrep download redirected to disallowed host: ${currentUrl.hostname}`)
              }
              const response: Response = yield* Effect.tryPromise({
                try: () => fetch(currentUrl.toString(), { redirect: "manual", signal }),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              })
              if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location")
                if (!location) throw new Error("ripgrep download redirect missing Location header")
                currentUrl = new URL(location, currentUrl)
                hops++
                continue
              }
              if (!response.ok) {
                throw new Error(
                  `failed to download ripgrep from ${currentUrl}: HTTP ${response.status} ${response.statusText}`,
                )
              }
              finalResponse = response
              break
            }

            if (!finalResponse) throw new Error("too many redirects while downloading ripgrep")

            const arrayBuffer = yield* Effect.tryPromise({
              try: () => finalResponse!.arrayBuffer(),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
            const bytes = new Uint8Array(arrayBuffer)
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)

            const actualHash = crypto.createHash("sha256").update(bytes).digest("hex")
            if (actualHash !== config.sha256) {
              throw new Error(
                `ripgrep checksum mismatch for ${filename}: expected ${config.sha256}, got ${actualHash}`,
              )
            }

            yield* fs.writeWithDirs(archive, bytes)
            yield* extract(archive, config, target)
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            return target
          }).pipe(
            Effect.catchDefect((defect) =>
              Effect.fail(defect instanceof Error ? defect : new Error(`ripgrep unavailable: ${String(defect)}`)),
            ),
          ),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, CrossSpawnSpawner.node],
  })
}
