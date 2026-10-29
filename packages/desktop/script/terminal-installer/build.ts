import { lstat, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { planTerminalInstaller, stageTerminalInstaller, type TerminalPlatform } from "./index"

export const usage = `Usage: bun packages/desktop/script/terminal-installer/build.ts \\
  --platform <darwin|linux|win32> \\
  --node-root <directory> --node-executable <relative-path> \\
  --cli-root <directory> --cli-entrypoint <relative-path> \\
  --output <new-directory>`

export interface TerminalInstallerBuildOptions {
  platform: TerminalPlatform
  nodeRoot: string
  nodeExecutable: string
  cliRoot: string
  cliEntrypoint: string
  output: string
}

const flags = {
  "--platform": "platform",
  "--node-root": "nodeRoot",
  "--node-executable": "nodeExecutable",
  "--cli-root": "cliRoot",
  "--cli-entrypoint": "cliEntrypoint",
  "--output": "output",
} as const satisfies Record<string, keyof TerminalInstallerBuildOptions>

export function parseTerminalInstallerBuildArgs(args: string[]): TerminalInstallerBuildOptions {
  const parsed: Partial<Record<keyof TerminalInstallerBuildOptions, string>> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!(flag in flags)) throw new Error(`Unknown option: ${flag ?? "<missing>"}`)
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
    const key = flags[flag as keyof typeof flags]
    if (parsed[key] !== undefined) throw new Error(`Duplicate option: ${flag}`)
    parsed[key] = value
  }

  for (const [flag, key] of Object.entries(flags)) {
    if (parsed[key] === undefined) throw new Error(`Missing required option: ${flag}`)
  }
  if (parsed.platform !== "darwin" && parsed.platform !== "linux" && parsed.platform !== "win32") {
    throw new Error(`Unsupported platform: ${parsed.platform}`)
  }
  return parsed as unknown as TerminalInstallerBuildOptions
}

const portablePath = (root: string, candidate: string): string => {
  const relative = path.relative(root, candidate).split(path.sep).join("/")
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error("Discovered artifact path escapes its root")
  }
  return relative
}

export async function discoverArtifactFiles(root: string, label: string): Promise<string[]> {
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink()) throw new Error(`${label} root must not be a symbolic link`)
  if (!rootStat.isDirectory()) throw new Error(`${label} root must be a directory`)
  const canonicalRoot = await realpath(root)
  const files: string[] = []

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      const stat = await lstat(candidate)
      const relative = portablePath(canonicalRoot, candidate)
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${relative}`)
      if (stat.isDirectory()) {
        await visit(candidate)
        continue
      }
      if (!stat.isFile()) throw new Error(`${label} contains a non-regular file: ${relative}`)
      files.push(relative)
    }
  }

  await visit(canonicalRoot)
  return files.sort((left, right) => left.localeCompare(right, "en"))
}

export async function buildTerminalInstaller(options: TerminalInstallerBuildOptions): Promise<void> {
  const [nodeFiles, cliFiles] = await Promise.all([
    discoverArtifactFiles(options.nodeRoot, "Node artifact"),
    discoverArtifactFiles(options.cliRoot, "Kothora CLI artifact"),
  ])
  const plan = await planTerminalInstaller({
    platform: options.platform,
    node: {
      root: options.nodeRoot,
      executable: options.nodeExecutable,
      files: nodeFiles,
    },
    cli: {
      root: options.cliRoot,
      entrypoint: options.cliEntrypoint,
      files: cliFiles,
    },
  })
  await stageTerminalInstaller(plan, options.output)
}

export async function runTerminalInstallerBuild(args: string[]): Promise<void> {
  await buildTerminalInstaller(parseTerminalInstallerBuildArgs(args))
}

if (import.meta.main) {
  try {
    await runTerminalInstallerBuild(process.argv.slice(2))
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown build failure"
    console.error(`terminal-installer: ${detail}\n${usage}`)
    process.exitCode = 1
  }
}
