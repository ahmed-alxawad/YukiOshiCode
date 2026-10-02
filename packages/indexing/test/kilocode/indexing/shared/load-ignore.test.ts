import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { loadIgnore } from "../../../../src/indexing/shared/load-ignore"
import { FileIgnore } from "../../../../src/file/ignore"

describe("loadIgnore", () => {
  let root = ""

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "index-ignore-"))
  })

  afterEach(async () => {
    if (!root) {
      return
    }
    await rm(root, { recursive: true, force: true })
  })

  test("loads root YukiOshi and legacy ignore files in addition to .gitignore", async () => {
    await writeFile(path.join(root, ".gitignore"), "dist/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "secret/\n")
    await writeFile(path.join(root, ".yukioshiignore"), "private/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("dist/out.ts")).toBe(true)
    expect(ig.ignores("secret/key.ts")).toBe(true)
    expect(ig.ignores("private/key.ts")).toBe(true)
    expect(ig.ignores("src/app.ts")).toBe(false)
  })

  test("preserves existing .gitignore-only behavior when .kilocodeignore is absent", async () => {
    await writeFile(path.join(root, ".gitignore"), "coverage/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("coverage/index.html")).toBe(true)
    expect(ig.ignores("src/app.ts")).toBe(false)
  })

  test("loads nested .kilocodeignore relative to its directory", async () => {
    await mkdir(path.join(root, "pkg", "sub"), { recursive: true })
    await writeFile(path.join(root, "pkg", ".kilocodeignore"), "secret.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/secret.ts")).toBe(true)
    expect(ig.ignores("pkg/sub/secret.ts")).toBe(true)
    expect(ig.ignores("secret.ts")).toBe(false)
    expect(ig.ignores("pkg/open.ts")).toBe(false)
  })

  test("anchors nested patterns that start with slash to the ignore file directory", async () => {
    await mkdir(path.join(root, "pkg", "sub"), { recursive: true })
    await writeFile(path.join(root, "pkg", ".gitignore"), "/secret.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/secret.ts")).toBe(true)
    expect(ig.ignores("pkg/sub/secret.ts")).toBe(false)
  })

  test("matches nested bare directory patterns at any depth", async () => {
    await mkdir(path.join(root, "pkg", "sub"), { recursive: true })
    await writeFile(path.join(root, "pkg", ".gitignore"), "dist/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/dist/file.ts")).toBe(true)
    expect(ig.ignores("pkg/sub/dist/file.ts")).toBe(true)
  })

  test("derives simple prunes when no negation rules are present", async () => {
    await writeFile(path.join(root, ".gitignore"), ".venv/\n/generated-root/\n")
    await mkdir(path.join(root, "pkg"))
    await writeFile(path.join(root, "pkg", ".gitignore"), "generated/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores(".venv/file.ts")).toBe(true)
    expect(ig.ignores("generated-root/file.ts")).toBe(true)
    expect(ig.ignores("pkg/sub/generated/file.ts")).toBe(true)
    expect(ig.ignores("outside/generated/file.ts")).toBe(false)
    expect(ig.watchIgnoreGlobs?.()).toEqual(["**/.venv", "generated-root", "pkg/**/generated"])
  })

  test.each(["!data/", "!d*/", "!DATA/"])("keeps paths re-included by %s visible to the watcher", async (rule) => {
    await writeFile(path.join(root, ".gitignore"), `.venv/\n/pkg/data/\n${rule}\n`)

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/data/file.ts")).toBe(false)
    expect(ig.ignores(".venv/file.ts")).toBe(true)
    expect(ig.watchIgnoreGlobs?.()).toEqual([])
  })

  test.each([".gitignore", ".opencodeignore", ".kilocodeignore", ".yukioshiignore"])(
    "keeps nested %s re-includes visible to the watcher",
    async (name) => {
      await writeFile(path.join(root, ".gitignore"), "/pkg/sub/data/\n")
      await mkdir(path.join(root, "pkg"))
      await writeFile(path.join(root, "pkg", name), "!data/\n")

      const ig = await loadIgnore(root)

      expect(ig.ignores("pkg/sub/data/file.ts")).toBe(false)
      expect(ig.watchIgnoreGlobs?.()).toEqual([])
    },
  )

  test("lets child ignore files override parent rules with negation", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "*.ts\n")
    await writeFile(path.join(root, "pkg", ".gitignore"), "!keep.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("root.ts")).toBe(true)
    expect(ig.ignores("pkg/drop.ts")).toBe(true)
    expect(ig.ignores("pkg/keep.ts")).toBe(false)
  })

  test("keeps files ignored when a parent directory is ignored", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "pkg/\n")
    await writeFile(path.join(root, "pkg", ".gitignore"), "!keep.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/keep.ts")).toBe(true)
  })

  test("allows descendants when a parent directory is re-included", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "pkg/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!pkg/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/file.ts")).toBe(false)
  })

  test("keeps explicit file ignores when a parent directory is re-included", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "*.ts\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!pkg/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/file.ts")).toBe(true)
  })

  test("keeps explicit file ignores when a re-included parent also had explicit file rules", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "pkg/\npkg/*.ts\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!pkg/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/file.ts")).toBe(true)
  })

  test("keeps descendants ignored when only a child directory is re-included", async () => {
    await mkdir(path.join(root, "pkg", "sub"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "pkg/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!pkg/sub/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/sub/file.ts")).toBe(true)
  })

  test("allows child negation after a parent directory is re-included", async () => {
    await mkdir(path.join(root, "pkg"), { recursive: true })
    await writeFile(path.join(root, ".gitignore"), "pkg/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!pkg/\n")
    await writeFile(path.join(root, "pkg", ".gitignore"), "!keep.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg/keep.ts")).toBe(false)
  })

  test("applies .kilocodeignore after .gitignore in the same directory", async () => {
    await writeFile(path.join(root, ".gitignore"), "*.ts\n")
    await writeFile(path.join(root, ".kilocodeignore"), "!keep.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("drop.ts")).toBe(true)
    expect(ig.ignores("keep.ts")).toBe(false)
  })

  test("applies .yukioshiignore after legacy ignore files in the same directory", async () => {
    await writeFile(path.join(root, ".opencodeignore"), "*.ts\n")
    await writeFile(path.join(root, ".kilocodeignore"), "*.js\n")
    await writeFile(path.join(root, ".yukioshiignore"), "!keep.ts\n!keep.js\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("drop.ts")).toBe(true)
    expect(ig.ignores("drop.js")).toBe(true)
    expect(ig.ignores("keep.ts")).toBe(false)
    expect(ig.ignores("keep.js")).toBe(false)
  })

  test("ignores the ignore files themselves", async () => {
    await writeFile(path.join(root, ".gitignore"), "dist/\n")
    await writeFile(path.join(root, ".kilocodeignore"), "secret/\n")
    await writeFile(path.join(root, ".yukioshiignore"), "private/\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores(".gitignore")).toBe(true)
    expect(ig.ignores(".kilocodeignore")).toBe(true)
    expect(ig.ignores(".yukioshiignore")).toBe(true)
  })

  test("keeps ignore files ignored after negation rules", async () => {
    await writeFile(path.join(root, ".kilocodeignore"), "!.gitignore\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores(".gitignore")).toBe(true)
  })

  test("ignores ignore file names even when absent during loading", async () => {
    const ig = await loadIgnore(root)

    expect(ig.ignores(".gitignore")).toBe(true)
    expect(ig.ignores("pkg/.kilocodeignore")).toBe(true)
    expect(ig.ignores("pkg/.yukioshiignore")).toBe(true)
  })

  test("ignores YukiOshi and legacy generated worktrees", () => {
    expect(FileIgnore.match(".yukioshi/worktrees/task/src.ts")).toBe(true)
    expect(FileIgnore.match(".opencode/worktrees/task/src.ts")).toBe(true)
    expect(FileIgnore.match("src/worktrees/task/src.ts")).toBe(false)
  })

  test("does not load ignore files from hardcoded ignored folders", async () => {
    await mkdir(path.join(root, "dist"), { recursive: true })
    await writeFile(path.join(root, "dist", ".gitignore"), "*.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("dist/file.ts")).toBe(false)
  })

  test("escapes nested ignore file directory names in generated patterns", async () => {
    await mkdir(path.join(root, "pkg[1]"), { recursive: true })
    await writeFile(path.join(root, "pkg[1]", ".gitignore"), "secret.ts\n")

    const ig = await loadIgnore(root)

    expect(ig.ignores("pkg[1]/secret.ts")).toBe(true)
    expect(ig.ignores("pkg1/secret.ts")).toBe(false)
  })
})
