import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

export type TerminalPlatform = "darwin" | "linux" | "win32"

export interface TerminalInstallerArtifacts {
  platform: TerminalPlatform
  node: {
    root: string
    executable: string
    files: string[]
  }
  cli: {
    root: string
    entrypoint: string
    files: string[]
  }
}

export interface TerminalInstallManifestFile {
  path: string
  sha256: string
  size: number
}

export interface TerminalInstallManifest {
  format: 1
  platform: TerminalPlatform
  command: "kothora"
  nodeExecutable: string
  cliEntrypoint: string
  launcher: string
  files: TerminalInstallManifestFile[]
}

interface StagingFile extends TerminalInstallManifestFile {
  sourceRoot: string
  sourceRelative: string
  mode: number
}

export interface TerminalInstallPlan {
  manifest: TerminalInstallManifest
  manifestJson: string
  installScript: string
  launcherScript: string
  readonly stagingFiles: readonly StagingFile[]
}

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

const portableRelativePath = (value: string, label: string): string => {
  if (!value || value.includes("\\") || value.includes("\0"))
    throw new Error(`${label} must be a portable relative path`)
  if (path.posix.isAbsolute(value)) throw new Error(`${label} must be relative`)
  const normalized = path.posix.normalize(value)
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must not traverse outside its artifact`)
  }
  if (normalized !== value) throw new Error(`${label} must be normalized`)
  return normalized
}

const uniqueSorted = (values: string[], label: string): string[] => {
  const normalized = values.map((value) => portableRelativePath(value, label))
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right, "en"))
  if (unique.length !== normalized.length) throw new Error(`${label} contains duplicate paths`)
  return unique
}

const ensureArtifactRoot = async (root: string, label: string): Promise<string> => {
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) throw new Error(`${label} root must not be a symbolic link`)
  if (!stat.isDirectory()) throw new Error(`${label} root must be a directory`)
  return realpath(root)
}

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

const readArtifact = async (
  root: string,
  relative: string,
  label: string,
): Promise<{ content: Uint8Array; mode: number }> => {
  let cursor = root
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment)
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`)
  }
  const canonical = await realpath(cursor)
  if (!isInside(root, canonical)) throw new Error(`${label} escapes its artifact root`)
  const stat = await lstat(canonical)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  const content = await readFile(canonical)
  if (content.byteLength === 0) throw new Error(`${label} must not be empty`)
  return { content, mode: stat.mode }
}

const unixLauncher = (nodeExecutable: string, cliEntrypoint: string): string => `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$ROOT/${nodeExecutable}" "$ROOT/${cliEntrypoint}" "$@"
`

const windowsLauncher = (nodeExecutable: string, cliEntrypoint: string): string => `@echo off\r
setlocal\r
set "KOTHORA_ROOT=%~dp0.."\r
"%KOTHORA_ROOT%\\${nodeExecutable.replaceAll("/", "\\")}" "%KOTHORA_ROOT%\\${cliEntrypoint.replaceAll("/", "\\")}" %*\r
`

const unixInstaller = (): string => `#!/bin/sh
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESTINATION=\${1:-"$HOME/.kothora/terminal"}
umask 077
mkdir -p -- "$DESTINATION"
cp -R -- "$SOURCE/runtime" "$SOURCE/cli" "$SOURCE/bin" "$SOURCE/manifest.json" "$DESTINATION/"
printf '%s\n' "Installed Kothora terminal command in $DESTINATION/bin"
`

const windowsInstaller = (): string => `$ErrorActionPreference = "Stop"
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Destination = if ($args.Count -gt 0) { $args[0] } else { Join-Path $env:LOCALAPPDATA "Kothora\\terminal" }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Payload = @("runtime", "cli", "bin", "manifest.json") | ForEach-Object { Join-Path $Source $_ }
Copy-Item -Recurse -Force -Path $Payload -Destination $Destination
Write-Output "Installed Kothora terminal command in $Destination\\bin"
`

export async function planTerminalInstaller(artifacts: TerminalInstallerArtifacts): Promise<TerminalInstallPlan> {
  const nodeRoot = await ensureArtifactRoot(artifacts.node.root, "Node artifact")
  const cliRoot = await ensureArtifactRoot(artifacts.cli.root, "Kothora CLI artifact")
  const nodeExecutable = portableRelativePath(artifacts.node.executable, "Node executable")
  const cliEntrypoint = portableRelativePath(artifacts.cli.entrypoint, "Kothora CLI entrypoint")
  const nodeFiles = uniqueSorted(artifacts.node.files, "Node artifact file")
  const cliFiles = uniqueSorted(artifacts.cli.files, "Kothora CLI artifact file")
  if (!nodeFiles.includes(nodeExecutable)) throw new Error("Node executable must be included in Node artifact files")
  if (!cliFiles.includes(cliEntrypoint))
    throw new Error("Kothora CLI entrypoint must be included in CLI artifact files")

  const stagingFiles: StagingFile[] = []
  for (const relative of nodeFiles) {
    const artifact = await readArtifact(nodeRoot, relative, `Node artifact file ${relative}`)
    stagingFiles.push({
      path: `runtime/${relative}`,
      sha256: sha256(artifact.content),
      size: artifact.content.byteLength,
      sourceRoot: nodeRoot,
      sourceRelative: relative,
      mode: relative === nodeExecutable ? 0o755 : artifact.mode & 0o777,
    })
  }
  for (const relative of cliFiles) {
    const artifact = await readArtifact(cliRoot, relative, `Kothora CLI artifact file ${relative}`)
    stagingFiles.push({
      path: `cli/${relative}`,
      sha256: sha256(artifact.content),
      size: artifact.content.byteLength,
      sourceRoot: cliRoot,
      sourceRelative: relative,
      mode: artifact.mode & 0o777,
    })
  }
  stagingFiles.sort((left, right) => left.path.localeCompare(right.path, "en"))

  const windows = artifacts.platform === "win32"
  const launcher = windows ? "bin/kothora.cmd" : "bin/kothora"
  const launcherScript = windows
    ? windowsLauncher(`runtime/${nodeExecutable}`, `cli/${cliEntrypoint}`)
    : unixLauncher(`runtime/${nodeExecutable}`, `cli/${cliEntrypoint}`)
  const launcherBytes = new TextEncoder().encode(launcherScript)
  const manifest: TerminalInstallManifest = {
    format: 1,
    platform: artifacts.platform,
    command: "kothora",
    nodeExecutable: `runtime/${nodeExecutable}`,
    cliEntrypoint: `cli/${cliEntrypoint}`,
    launcher,
    files: [
      ...stagingFiles.map(({ path: filePath, sha256: digest, size }) => ({ path: filePath, sha256: digest, size })),
      { path: launcher, sha256: sha256(launcherBytes), size: launcherBytes.byteLength },
    ].sort((left, right) => left.path.localeCompare(right.path, "en")),
  }
  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    installScript: windows ? windowsInstaller() : unixInstaller(),
    launcherScript,
    stagingFiles,
  }
}

const ensureNewStagingRoot = async (stagingRoot: string): Promise<void> => {
  try {
    await lstat(stagingRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    return
  }
  throw new Error("Staging destination already exists")
}

export async function stageTerminalInstaller(plan: TerminalInstallPlan, stagingRoot: string): Promise<void> {
  await ensureNewStagingRoot(stagingRoot)
  for (const file of plan.stagingFiles) {
    const artifact = await readArtifact(file.sourceRoot, file.sourceRelative, `Artifact ${file.path}`)
    const content = artifact.content
    if (content.byteLength !== file.size || sha256(content) !== file.sha256) {
      throw new Error(`Artifact changed before staging: ${file.path}`)
    }
    const destination = path.join(stagingRoot, ...file.path.split("/"))
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, content, { mode: file.mode })
    if (plan.manifest.platform !== "win32") await chmod(destination, file.mode)
  }
  const launcher = path.join(stagingRoot, ...plan.manifest.launcher.split("/"))
  await mkdir(path.dirname(launcher), { recursive: true, mode: 0o700 })
  await writeFile(launcher, plan.launcherScript, {
    encoding: "utf8",
    mode: plan.manifest.platform === "win32" ? 0o600 : 0o755,
  })
  await writeFile(path.join(stagingRoot, "manifest.json"), plan.manifestJson, { encoding: "utf8", mode: 0o600 })
  const installerName = plan.manifest.platform === "win32" ? "install.ps1" : "install.sh"
  await writeFile(path.join(stagingRoot, installerName), plan.installScript, {
    encoding: "utf8",
    mode: plan.manifest.platform === "win32" ? 0o600 : 0o755,
  })
}
