import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  planTerminalInstaller,
  stageTerminalInstaller,
  type TerminalInstallerArtifacts,
} from "../../script/terminal-installer"

const temporaryRoots: string[] = []

const fixture = async (platform: "linux" | "win32" = "linux") => {
  const root = await mkdtemp(path.join(tmpdir(), "kothora-terminal-installer-"))
  temporaryRoots.push(root)
  const nodeRoot = path.join(root, "node")
  const cliRoot = path.join(root, "cli")
  await mkdir(path.join(nodeRoot, "bin"), { recursive: true })
  await mkdir(path.join(cliRoot, "dist"), { recursive: true })
  const nodeExecutable = platform === "win32" ? "node.exe" : "bin/node"
  await writeFile(path.join(nodeRoot, nodeExecutable), "bundled node", { mode: 0o755 })
  await writeFile(path.join(cliRoot, "dist/index.js"), "console.log('kothora')\n")
  await writeFile(path.join(cliRoot, "package.json"), '{"type":"module"}\n')
  const artifacts: TerminalInstallerArtifacts = {
    platform,
    node: { root: nodeRoot, executable: nodeExecutable, files: [nodeExecutable] },
    cli: { root: cliRoot, entrypoint: "dist/index.js", files: ["package.json", "dist/index.js"] },
  }
  return { root, nodeRoot, cliRoot, artifacts }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("terminal installer planning", () => {
  test("produces a deterministic Linux manifest and secret-free local scripts", async () => {
    const { artifacts } = await fixture()
    const first = await planTerminalInstaller(artifacts)
    const second = await planTerminalInstaller({
      ...artifacts,
      cli: { ...artifacts.cli, files: [...artifacts.cli.files].reverse() },
    })

    expect(second.manifestJson).toBe(first.manifestJson)
    expect(first.manifest.files.map((file) => file.path)).toEqual([
      "bin/kothora",
      "cli/dist/index.js",
      "cli/package.json",
      "runtime/bin/node",
    ])
    expect(first.manifest.nodeExecutable).toBe("runtime/bin/node")
    expect(first.launcherScript).toContain('exec "$ROOT/runtime/bin/node" "$ROOT/cli/dist/index.js" "$@"')
    expect(first.installScript).not.toContain("http://")
    expect(first.installScript).not.toContain("https://")
    expect(first.manifestJson).not.toContain(artifacts.node.root)
  })

  test("produces Windows paths and scripts without depending on a system Node", async () => {
    const { artifacts } = await fixture("win32")
    const plan = await planTerminalInstaller(artifacts)

    expect(plan.manifest.launcher).toBe("bin/kothora.cmd")
    expect(plan.launcherScript).toContain('"%KOTHORA_ROOT%\\runtime\\node.exe"')
    expect(plan.launcherScript).toContain('"%KOTHORA_ROOT%\\cli\\dist\\index.js"')
    expect(plan.installScript).toContain("$env:LOCALAPPDATA")
    expect(plan.installScript).not.toContain("github.com")
  })

  test("rejects traversal, absolute paths, duplicate files, and missing entrypoints", async () => {
    const { artifacts } = await fixture()
    await expect(
      planTerminalInstaller({ ...artifacts, node: { ...artifacts.node, executable: "../node" } }),
    ).rejects.toThrow("traverse")
    await expect(
      planTerminalInstaller({ ...artifacts, cli: { ...artifacts.cli, files: ["/etc/passwd", "dist/index.js"] } }),
    ).rejects.toThrow("relative")
    await expect(
      planTerminalInstaller({ ...artifacts, cli: { ...artifacts.cli, files: ["dist/index.js", "dist/index.js"] } }),
    ).rejects.toThrow("duplicate")
    await expect(
      planTerminalInstaller({ ...artifacts, cli: { ...artifacts.cli, files: ["package.json"] } }),
    ).rejects.toThrow("entrypoint")
  })

  test("rejects symlinked roots, files, and intermediate directories", async () => {
    const { root, nodeRoot, cliRoot, artifacts } = await fixture()
    const linkedRoot = path.join(root, "linked-node")
    await symlink(nodeRoot, linkedRoot, "dir")
    await expect(
      planTerminalInstaller({ ...artifacts, node: { ...artifacts.node, root: linkedRoot } }),
    ).rejects.toThrow("symbolic link")

    const linkedFile = path.join(cliRoot, "linked.js")
    await symlink(path.join(cliRoot, "dist/index.js"), linkedFile)
    await expect(
      planTerminalInstaller({ ...artifacts, cli: { ...artifacts.cli, files: ["linked.js"], entrypoint: "linked.js" } }),
    ).rejects.toThrow("symbolic links")

    await mkdir(path.join(cliRoot, "real"))
    await writeFile(path.join(cliRoot, "real/index.js"), "safe")
    await symlink(path.join(cliRoot, "real"), path.join(cliRoot, "linked-dir"), "dir")
    await expect(
      planTerminalInstaller({
        ...artifacts,
        cli: { ...artifacts.cli, files: ["linked-dir/index.js"], entrypoint: "linked-dir/index.js" },
      }),
    ).rejects.toThrow("symbolic links")
  })
})

describe("terminal installer staging", () => {
  test("stages verified payloads, manifest, launcher, and installer", async () => {
    const { root, artifacts } = await fixture()
    const plan = await planTerminalInstaller(artifacts)
    const stagingRoot = path.join(root, "staged")
    await stageTerminalInstaller(plan, stagingRoot)

    expect(await readFile(path.join(stagingRoot, "runtime/bin/node"), "utf8")).toBe("bundled node")
    expect(await readFile(path.join(stagingRoot, "cli/dist/index.js"), "utf8")).toContain("kothora")
    expect(await readFile(path.join(stagingRoot, "manifest.json"), "utf8")).toBe(plan.manifestJson)
    expect(await readFile(path.join(stagingRoot, "install.sh"), "utf8")).toBe(plan.installScript)
  })

  test("rejects artifacts changed after planning and existing staging destinations", async () => {
    const { root, artifacts } = await fixture()
    const plan = await planTerminalInstaller(artifacts)
    await writeFile(path.join(artifacts.cli.root, artifacts.cli.entrypoint), "changed")
    await expect(stageTerminalInstaller(plan, path.join(root, "staged"))).rejects.toThrow("changed before staging")

    const fresh = await fixture()
    const freshPlan = await planTerminalInstaller(fresh.artifacts)
    const existing = path.join(fresh.root, "existing")
    await mkdir(existing)
    await expect(stageTerminalInstaller(freshPlan, existing)).rejects.toThrow("already exists")
  })
})
