import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildTerminalInstaller,
  discoverArtifactFiles,
  parseTerminalInstallerBuildArgs,
  usage,
} from "../../script/terminal-installer/build"

const temporaryRoots: string[] = []

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kothora-terminal-build-"))
  temporaryRoots.push(root)
  const nodeRoot = path.join(root, "node")
  const cliRoot = path.join(root, "cli")
  await mkdir(path.join(nodeRoot, "bin"), { recursive: true })
  await mkdir(path.join(cliRoot, "dist", "nested"), { recursive: true })
  await writeFile(path.join(nodeRoot, "bin/node"), "bundled node", { mode: 0o755 })
  await writeFile(path.join(nodeRoot, "NOTICE"), "Node notice")
  await writeFile(path.join(cliRoot, "dist/index.js"), "console.log('kothora')")
  await writeFile(path.join(cliRoot, "dist/nested/chunk.js"), "export {}")
  return { root, nodeRoot, cliRoot, output: path.join(root, "output") }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("terminal installer build CLI", () => {
  test("requires explicit, deterministic build options", () => {
    const validArgs = [
      "--platform",
      "linux",
      "--node-root",
      "/artifacts/node",
      "--node-executable",
      "bin/node",
      "--cli-root",
      "/artifacts/cli",
      "--cli-entrypoint",
      "dist/index.js",
      "--output",
      "/release/terminal",
    ]
    expect(parseTerminalInstallerBuildArgs(validArgs)).toEqual({
      platform: "linux",
      nodeRoot: "/artifacts/node",
      nodeExecutable: "bin/node",
      cliRoot: "/artifacts/cli",
      cliEntrypoint: "dist/index.js",
      output: "/release/terminal",
    })
    expect(() => parseTerminalInstallerBuildArgs(["--platform", "linux"])).toThrow("--node-root")
    expect(() => parseTerminalInstallerBuildArgs(validArgs.with(1, "android"))).toThrow("Unsupported platform: android")
    expect(() => parseTerminalInstallerBuildArgs(["--download", "latest"])).toThrow("Unknown option")
    expect(usage).not.toContain("http://")
    expect(usage).not.toContain("https://")
  })

  test("discovers only regular files in stable portable-path order", async () => {
    const { cliRoot } = await fixture()
    expect(await discoverArtifactFiles(cliRoot, "CLI")).toEqual(["dist/index.js", "dist/nested/chunk.js"])
  })

  test("rejects symlinked files and directories without following them", async () => {
    const { root, cliRoot } = await fixture()
    await symlink(path.join(cliRoot, "dist/index.js"), path.join(cliRoot, "linked.js"))
    await expect(discoverArtifactFiles(cliRoot, "CLI")).rejects.toThrow("symbolic link: linked.js")

    const clean = await fixture()
    await symlink(root, path.join(clean.cliRoot, "outside"), "dir")
    await expect(discoverArtifactFiles(clean.cliRoot, "CLI")).rejects.toThrow("symbolic link: outside")
  })

  test("stages a complete release bundle without URLs or a system-Node launcher", async () => {
    const { nodeRoot, cliRoot, output } = await fixture()
    await buildTerminalInstaller({
      platform: "linux",
      nodeRoot,
      nodeExecutable: "bin/node",
      cliRoot,
      cliEntrypoint: "dist/index.js",
      output,
    })

    const launcher = await readFile(path.join(output, "bin/kothora"), "utf8")
    const manifest = await readFile(path.join(output, "manifest.json"), "utf8")
    expect(launcher).toContain('"$ROOT/runtime/bin/node"')
    expect(launcher).not.toMatch(/(^|\s)node(\s|$)/)
    expect(manifest).toContain('"path": "runtime/NOTICE"')
    expect(manifest).toContain('"path": "cli/dist/nested/chunk.js"')
    expect(`${launcher}\n${manifest}`).not.toContain("http://")
    expect(`${launcher}\n${manifest}`).not.toContain("https://")
  })

  test("refuses to overwrite an existing release directory", async () => {
    const { nodeRoot, cliRoot, output } = await fixture()
    await mkdir(output)
    await expect(
      buildTerminalInstaller({
        platform: "linux",
        nodeRoot,
        nodeExecutable: "bin/node",
        cliRoot,
        cliEntrypoint: "dist/index.js",
        output,
      }),
    ).rejects.toThrow("already exists")
  })
})
