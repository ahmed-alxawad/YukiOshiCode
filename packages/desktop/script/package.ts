import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type DesktopTarget = "darwin" | "linux" | "win32"

export interface PackageOptions {
  agent: string
  target: DesktopTarget
}

export interface PackageDependencies {
  runBuild: () => Promise<void>
  runElectronBuilder: (target: DesktopTarget, extraResources: { from: string; to: string }[]) => Promise<void>
}

export const usage = "Usage: bun run package --agent <prebuilt-binary> [--target darwin|linux|win32]"

export function parsePackageArgs(args: string[], host: NodeJS.Platform = process.platform): PackageOptions {
  let agent: string | undefined
  let target = host
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${option ?? "option"}`)
    if (option === "--agent") agent = value
    else if (option === "--target") target = value as NodeJS.Platform
    else throw new Error(`Unknown option: ${option}`)
  }
  if (!agent) throw new Error("Missing required option: --agent")
  if (target !== "darwin" && target !== "linux" && target !== "win32") {
    throw new Error(`Unsupported target: ${target}`)
  }
  return { agent, target }
}

export async function validateAgentBinary(input: string, target: DesktopTarget): Promise<string> {
  const candidate = isAbsolute(input) ? input : resolve(process.cwd(), input)
  const entry = await lstat(candidate).catch(() => undefined)
  if (!entry) throw new Error(`Agent binary does not exist: ${candidate}`)
  if (entry.isSymbolicLink()) throw new Error(`Agent binary must not be a symbolic link: ${candidate}`)
  if (!entry.isFile()) throw new Error(`Agent binary must be a regular file: ${candidate}`)
  if (target !== "win32" && (entry.mode & 0o111) === 0) {
    throw new Error(`Agent binary must be executable: ${candidate}`)
  }
  return realpath(candidate)
}

export async function packageDesktop(options: PackageOptions, dependencies: PackageDependencies): Promise<void> {
  const binary = await validateAgentBinary(options.agent, options.target)
  const filename = options.target === "win32" ? "yukioshi.exe" : "yukioshi"
  await dependencies.runBuild()
  await dependencies.runElectronBuilder(options.target, [{ from: binary, to: `agent/${filename}` }])
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`)
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parsePackageArgs(args)
  await packageDesktop(options, {
    runBuild: () => run([process.execPath, "run", "build"]),
    runElectronBuilder: async (target, extraResources) => {
      const { build } = await import("electron-builder")
      const platform = target === "darwin" ? { mac: [] } : target === "win32" ? { win: [] } : { linux: [] }
      await build({ ...platform, config: { extraResources } })
    },
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  })
}
