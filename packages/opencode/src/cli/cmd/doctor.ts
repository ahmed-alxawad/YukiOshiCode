import { access, constants, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { Global } from "@yukioshi/core/global"
import { which } from "@yukioshi/core/util/which"
import { sandboxEffect } from "./debug/sandbox"
import { sandboxStatus } from "@yukioshi/sandbox"
import { effectCmd } from "../effect-cmd"
import { Effect } from "effect"
import { parse } from "jsonc-parser"

export type DoctorStatus = "ok" | "problem" | "skipped"
export type DoctorCheck = { name: string; status: DoctorStatus; detail: string; path?: string }
export type DoctorReport = { version: string; ok: boolean; checks: DoctorCheck[] }

type DoctorInput = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  executable?: string
  paths?: { config: string; state: string }
  command?: (name: string) => string | null
  network?: boolean
  fetch?: (url: string) => Promise<Response>
  installationMethod?: string
}

const configNames = ["yukioshi.json", "yukioshi.jsonc", "opencode.json", "opencode.jsonc", "config.json"]
const providerHosts: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://api.anthropic.com",
  OPENAI_API_KEY: "https://api.openai.com",
  GOOGLE_API_KEY: "https://generativelanguage.googleapis.com",
  GEMINI_API_KEY: "https://generativelanguage.googleapis.com",
  XAI_API_KEY: "https://api.x.ai",
}
const supportedProviderEnv = new Set([
  ...Object.keys(providerHosts),
  "AZURE_API_KEY",
  "CEREBRAS_API_KEY",
  "COHERE_API_KEY",
  "DEEPINFRA_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "YUKIOSHI_API_KEY",
])

function hasProviderKey(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.some(hasProviderKey)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([name, child]) => {
    if (name === "key" || name === "apiKey" || name === "apiKeys") return hasProviderKey(child)
    return child !== null && typeof child === "object" && hasProviderKey(child)
  })
}

function configHasProviderKey(text: string) {
  const errors: { error: number; offset: number; length: number }[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true }) as { provider?: unknown } | undefined
  return errors.length === 0 && hasProviderKey(parsed?.provider)
}

function commandFor(name: string, input: DoctorInput) {
  return input.command?.(name) ?? which(name)
}

async function findConfigFiles(cwd: string, config: string) {
  const found: string[] = []
  let dir = path.resolve(cwd)
  while (true) {
    for (const name of configNames) {
      const file = path.join(dir, name)
      try {
        await access(file, constants.R_OK)
        found.push(file)
      } catch {}
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const name of configNames) {
    const file = path.join(config, name)
    try {
      await access(file, constants.R_OK)
      found.push(file)
    } catch {}
  }
  return [...new Set(found)]
}

async function writable(dir: string) {
  try {
    await access(dir, constants.W_OK)
    const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}`)
    await writeFile(probe, "")
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

async function reachability(host: string, fetcher: (url: string) => Promise<Response>) {
  try {
    const response = await fetcher(host)
    return response.status < 500
  } catch {
    return false
  }
}

export async function runDoctor(input: DoctorInput = {}): Promise<DoctorReport> {
  const cwd = input.cwd ?? process.cwd()
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const executable = input.executable ?? process.execPath
  const paths = input.paths ?? { config: Global.Path.config, state: Global.Path.state }
  const checks: DoctorCheck[] = []
  const add = (name: string, status: DoctorStatus, detail: string, checkPath?: string) =>
    checks.push({ name, status, detail, ...(checkPath ? { path: checkPath } : {}) })

  add("version", InstallationVersion ? "ok" : "problem", InstallationVersion || "version is unavailable")
  const installMethod =
    input.installationMethod ??
    (executable.includes(path.join(".yukioshi", "bin")) || executable.includes(path.join(".local", "bin"))
      ? "curl"
      : (env.npm_config_user_agent?.split("/")[0] ?? "unknown"))
  add("install method", installMethod === "unknown" ? "problem" : "ok", installMethod)

  const configs = await findConfigFiles(cwd, paths.config)
  add(
    "config files",
    configs.length ? "ok" : "problem",
    configs.length ? `${configs.length} found` : "none found",
    configs[0],
  )

  const keyNames = Object.keys(env).filter((name) => supportedProviderEnv.has(name) && Boolean(env[name]?.trim()))
  let configured = keyNames.length > 0
  for (const file of configs) {
    try {
      const text = await readFile(file, "utf8")
      if (configHasProviderKey(text)) configured = true
    } catch {}
  }
  add(
    "provider keys",
    configured ? "ok" : "problem",
    configured ? `${keyNames.length || 1} provider key(s) present` : "no provider key found",
  )

  const git = commandFor("git", input)
  add("git", git ? "ok" : "problem", git ? "available" : "not found", git ?? undefined)
  const rg = commandFor("rg", input)
  add("rg", rg ? "ok" : "problem", rg ? "available" : "not found", rg ?? undefined)

  const sandbox = sandboxStatus()
  add(
    "sandbox",
    sandbox.available ? "ok" : "problem",
    `${sandbox.summary}; ${sandboxEffect(sandbox.available, true, platform)}`,
  )

  const clipboard =
    platform === "win32"
      ? commandFor("clip", input)
      : platform === "darwin"
        ? commandFor("pbcopy", input)
        : (commandFor("wl-copy", input) ?? commandFor("xclip", input))
  add("clipboard", clipboard ? "ok" : "problem", clipboard ? "available" : "not found", clipboard ?? undefined)
  const stateWritable = await writable(paths.state)
  add("writable state", stateWritable ? "ok" : "problem", stateWritable ? "writable" : "not writable", paths.state)

  if (input.network) {
    const fetcher = input.fetch ?? ((url: string) => fetch(url, { method: "HEAD" }))
    const hosts = [...new Set(keyNames.map((name) => providerHosts[name]).filter(Boolean))]
    if (!hosts.length) add("network", "skipped", "no known provider host")
    for (const host of hosts) add("network", (await reachability(host, fetcher)) ? "ok" : "problem", host)
  }
  return { version: InstallationVersion, ok: checks.every((check) => check.status !== "problem"), checks }
}

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check installation, providers, tools, sandbox, clipboard, and state",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("network", { type: "boolean", default: false, describe: "check provider host reachability" })
      .option("format", { type: "string", choices: ["text", "json"], default: "text" }),
  handler: Effect.fn("Cli.doctor")(function* (args) {
    const { Installation } = yield* Effect.promise(() => import("@/installation"))
    const installationMethod = yield* Installation.Service.use((service) => service.method())
    const report = yield* Effect.promise(() => runDoctor({ network: args.network, installationMethod }))
    if (args.format === "json") process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    else
      for (const check of report.checks)
        console.log(
          `${check.status === "ok" ? "OK" : check.status === "skipped" ? "SKIP" : "PROBLEM"} ${check.name}: ${check.detail}`,
        )
    if (!report.ok) process.exitCode = 1
  }),
})
