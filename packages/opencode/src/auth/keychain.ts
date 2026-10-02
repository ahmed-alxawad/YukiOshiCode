import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Global } from "@yukioshi/core/global"

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[], stdin?: string): Promise<ProcessResult>
}

export class DefaultProcessRunner implements ProcessRunner {
  run(executable: string, args: readonly string[], stdin?: string): Promise<ProcessResult> {
    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      let resolved = false

      const child = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })

      const timeoutMs = 15_000
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          child.kill("SIGKILL")
          resolve({ exitCode: 124, stdout, stderr: stderr || "Command timed out" })
        }
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve({ exitCode: 1, stdout, stderr: err.message })
        }
      })

      child.on("close", (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve({ exitCode: code ?? 0, stdout, stderr })
        }
      })

      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      } else {
        child.stdin?.end()
      }
    })
  }
}

export interface KeychainStore {
  readonly name: string
  isAvailable(): Promise<boolean>
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export function packSecret(value: string): string {
  return "b64:" + Buffer.from(value, "utf8").toString("base64")
}

export function unpackSecret(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("b64:")) {
    return Buffer.from(trimmed.slice(4), "base64").toString("utf8")
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8")
    if (decoded.startsWith("{") || decoded.startsWith("[")) {
      return decoded
    }
  } catch {}
  return trimmed
}

/** macOS Keychain via `/usr/bin/security`. */
export class MacKeychainStore implements KeychainStore {
  readonly name = "macOS Keychain"
  private cachedAvailable: Promise<boolean> | undefined

  constructor(
    private readonly runner: ProcessRunner = new DefaultProcessRunner(),
    private readonly service: string = "yukioshi-code",
  ) {}

  isAvailable(): Promise<boolean> {
    this.cachedAvailable ??= (async () => {
      const result = await this.runner.run("security", ["help"])
      return result.exitCode === 0
    })()
    return this.cachedAvailable
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.runner.run("security", [
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      key,
      "-w",
    ])
    if (result.exitCode !== 0) return undefined
    const raw = result.stdout.replace(/\r?\n$/, "")
    return raw ? unpackSecret(raw) : undefined
  }

  async set(key: string, value: string): Promise<void> {
    const payload = packSecret(value)
    // Pass add-generic-password on stdin to security -i to keep secret off argv
    const script = `add-generic-password -U -s "${this.service}" -a "${key}" -w "${payload}"\n`
    const result = await this.runner.run("security", ["-i"], script)
    if (result.exitCode !== 0) {
      throw new Error(`Keychain write failed: ${result.stderr.trim() || "unknown error"}`)
    }
  }

  async delete(key: string): Promise<void> {
    await this.runner.run("security", ["delete-generic-password", "-s", this.service, "-a", key])
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet) via `secret-tool` from libsecret. */
export class SecretServiceStore implements KeychainStore {
  readonly name = "Secret Service (libsecret)"
  private cachedAvailable: Promise<boolean> | undefined

  constructor(
    private readonly runner: ProcessRunner = new DefaultProcessRunner(),
    private readonly service: string = "yukioshi-code",
  ) {}

  isAvailable(): Promise<boolean> {
    this.cachedAvailable ??= (async () => {
      const ver = await this.runner.run("secret-tool", ["--version"])
      if (ver.exitCode !== 0) return false
      // Probe Secret Service daemon responsiveness
      const probe = await this.runner.run("secret-tool", ["lookup", "service", this.service, "account", "__probe__"])
      return !/(dbus|org\.freedesktop|cannot autolaunch|not provided by any|no such interface)/i.test(probe.stderr)
    })()
    return this.cachedAvailable
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.runner.run("secret-tool", ["lookup", "service", this.service, "account", key])
    if (result.exitCode !== 0) return undefined
    const raw = result.stdout.replace(/\r?\n$/, "")
    return raw ? unpackSecret(raw) : undefined
  }

  async set(key: string, value: string): Promise<void> {
    const payload = packSecret(value)
    const result = await this.runner.run(
      "secret-tool",
      ["store", `--label=YukiOshi Code (${key})`, "service", this.service, "account", key],
      payload,
    )
    if (result.exitCode !== 0) {
      throw new Error(`Secret Service write failed: ${result.stderr.trim() || "unknown error"}`)
    }
  }

  async delete(key: string): Promise<void> {
    await this.runner.run("secret-tool", ["clear", "service", this.service, "account", key])
  }
}

/** Windows DPAPI (CurrentUser scope) via PowerShell's ConvertTo-SecureString / ConvertFrom-SecureString. */
export class WindowsDpapiStore implements KeychainStore {
  readonly name = "Windows DPAPI"
  private cachedAvailable: Promise<boolean> | undefined

  constructor(
    private readonly runner: ProcessRunner = new DefaultProcessRunner(),
    private readonly directory: string = join(Global.Path.data, "secrets"),
    private readonly powershell: string = process.env.YUKIOSHI_POWERSHELL ?? "powershell.exe",
  ) {}

  private fileFor(key: string): string {
    return join(this.directory, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.dpapi`)
  }

  isAvailable(): Promise<boolean> {
    this.cachedAvailable ??= (async () => {
      const result = await this.runner.run(this.powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.Major",
      ])
      return result.exitCode === 0
    })()
    return this.cachedAvailable
  }

  async get(key: string): Promise<string | undefined> {
    const file = this.fileFor(key)
    if (!existsSync(file)) return undefined
    let blob: string
    try {
      blob = readFileSync(file, "utf8").trim()
    } catch {
      return undefined
    }
    const script =
      "$b=[Console]::In.ReadToEnd().Trim();$s=ConvertTo-SecureString -String $b;" +
      "$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);" +
      "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}"

    const result = await this.runner.run(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      blob,
    )
    if (result.exitCode !== 0 || !result.stdout) return undefined
    return unpackSecret(result.stdout)
  }

  async set(key: string, value: string): Promise<void> {
    const payload = packSecret(value)
    const script =
      "$v=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString -String $v -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))"
    const result = await this.runner.run(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      payload,
    )
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`DPAPI encryption failed: ${result.stderr.trim() || "unknown error"}`)
    }
    const file = this.fileFor(key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, result.stdout.trim(), { encoding: "utf8", mode: 0o600 })
  }

  async delete(key: string): Promise<void> {
    const file = this.fileFor(key)
    if (existsSync(file)) {
      rmSync(file, { force: true })
    }
  }
}

/** In-memory keychain store for testing and explicit ephemeral sessions. */
export class InMemoryKeychainStore implements KeychainStore {
  readonly name = "In-Memory Keychain"
  private readonly store = new Map<string, string>()

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(key))
  }

  set(key: string, value: string): Promise<void> {
    this.store.set(key, value)
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

export interface CreateKeychainOptions {
  platform?: NodeJS.Platform
  runner?: ProcessRunner
  service?: string
  secretsDir?: string
}

export function createKeychainStore(options: CreateKeychainOptions = {}): KeychainStore {
  const disabled =
    process.env.YUKIOSHI_DISABLE_KEYCHAIN === "1" ||
    process.env.YUKIOSHI_DISABLE_KEYCHAIN === "true"

  if (disabled) {
    return {
      name: "Disabled Keychain",
      isAvailable: () => Promise.resolve(false),
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error("Keychain disabled")),
      delete: () => Promise.resolve(),
    }
  }

  const platform = options.platform ?? process.platform
  const runner = options.runner ?? new DefaultProcessRunner()
  const service = options.service ?? process.env.YUKIOSHI_KEYCHAIN_SERVICE ?? "yukioshi-code"

  if (platform === "darwin") {
    return new MacKeychainStore(runner, service)
  }
  if (platform === "win32") {
    const dir = options.secretsDir ?? join(Global.Path.data, "secrets")
    return new WindowsDpapiStore(runner, dir)
  }
  return new SecretServiceStore(runner, service)
}
