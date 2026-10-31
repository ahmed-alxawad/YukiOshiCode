import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { packageDesktop, parsePackageArgs, validateAgentBinary } from "../../script/package"

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kothora-desktop-package-"))
  roots.push(root)
  const binary = path.join(root, "agent-build")
  await writeFile(binary, "binary", { mode: 0o755 })
  return { root, binary }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop package", () => {
  test("requires an explicit binary and validates the target", () => {
    expect(parsePackageArgs(["--agent", "/build/agent"], "linux")).toEqual({ agent: "/build/agent", target: "linux" })
    expect(parsePackageArgs(["--target", "win32", "--agent", "agent.exe"], "linux")).toEqual({
      agent: "agent.exe",
      target: "win32",
    })
    expect(() => parsePackageArgs([], "linux")).toThrow("--agent")
    expect(() => parsePackageArgs(["--agent", "a", "--target", "android"], "linux")).toThrow("Unsupported target")
    expect(() => parsePackageArgs(["--download", "latest"], "linux")).toThrow("Unknown option")
  })

  test("fails closed for missing, symlinked, directory, and non-executable inputs", async () => {
    const { root, binary } = await fixture()
    await expect(validateAgentBinary(path.join(root, "missing"), "linux")).rejects.toThrow("does not exist")
    const linked = path.join(root, "linked")
    await symlink(binary, linked)
    await expect(validateAgentBinary(linked, "linux")).rejects.toThrow("symbolic link")
    const directory = path.join(root, "directory")
    await mkdir(directory)
    await expect(validateAgentBinary(directory, "linux")).rejects.toThrow("regular file")
    await chmod(binary, 0o644)
    await expect(validateAgentBinary(binary, "linux")).rejects.toThrow("executable")
  })

  test("builds first and injects the validated binary as an unpacked resource", async () => {
    const { binary } = await fixture()
    const calls: string[] = []
    await packageDesktop(
      { agent: binary, target: "linux" },
      {
        runBuild: async () => void calls.push("build"),
        runElectronBuilder: async (target, resources) => void calls.push(`builder:${target}:${JSON.stringify(resources)}`),
      },
    )
    expect(calls).toEqual(["build", `builder:linux:${JSON.stringify([{ from: binary, to: "agent/yukioshi" }])}`])
  })

  test("uses the Windows executable name without requiring a Unix executable bit", async () => {
    const { binary } = await fixture()
    await chmod(binary, 0o644)
    let destination = ""
    await packageDesktop(
      { agent: binary, target: "win32" },
      {
        runBuild: async () => {},
        runElectronBuilder: async (_target, [resource]) => void (destination = resource?.to ?? ""),
      },
    )
    expect(destination).toBe("agent/yukioshi.exe")
  })
})
