import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { ProjectTrust } from "@/project/trust"
import { tmpdir } from "../fixture/fixture"

describe("project trust store", () => {
  test("defaults to untrusted, persists trust, and revokes it", async () => {
    await using state = await tmpdir()
    await using project = await tmpdir()
    const options = { state: state.path }

    expect(await ProjectTrust.isTrusted(project.path, options)).toBe(false)
    expect(await ProjectTrust.set(project.path, true, options)).toBe(project.path)
    expect(await ProjectTrust.isTrusted(project.path, options)).toBe(true)

    await ProjectTrust.set(project.path, false, options)
    expect(await ProjectTrust.isTrusted(project.path, options)).toBe(false)
  })

  test("uses canonical paths so symlink aliases cannot create a second identity", async () => {
    await using state = await tmpdir()
    await using root = await tmpdir()
    const project = path.join(root.path, "project")
    const alias = path.join(root.path, "alias")
    await mkdir(project)
    await symlink(project, alias, "dir")

    await ProjectTrust.set(alias, true, { state: state.path })

    expect(await ProjectTrust.isTrusted(project, { state: state.path })).toBe(true)
  })

  test("fails closed when the trust store is malformed", async () => {
    await using state = await tmpdir()
    await using project = await tmpdir()
    await writeFile(path.join(state.path, "project-trust.json"), "not json")

    expect(await ProjectTrust.isTrusted(project.path, { state: state.path })).toBe(false)
  })

  test("resolves nested directories to the nearest repository root without loading project config", async () => {
    await using project = await tmpdir()
    const nested = path.join(project.path, "packages", "app")
    await mkdir(path.join(project.path, ".git"))
    await mkdir(nested, { recursive: true })

    expect(await ProjectTrust.resolveRoot(nested)).toBe(project.path)
  })
})
