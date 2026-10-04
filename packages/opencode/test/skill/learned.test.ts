import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LearnedSkills } from "../../src/skill/learned"

const DAY = 24 * 60 * 60 * 1000

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "learned-skills-"))
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

describe("LearnedSkills", () => {
  test("is off unless turned on", () => {
    expect(LearnedSkills.settings(undefined).enabled).toBe(false)
    expect(LearnedSkills.settings({ max: 5 }).enabled).toBe(false)
    expect(LearnedSkills.settings(true)).toEqual({ enabled: true, max: 30, staleDays: 90 })
    expect(LearnedSkills.settings({ enabled: true, max: 5, stale_days: 7 })).toEqual({
      enabled: true,
      max: 5,
      staleDays: 7,
    })
  })

  test("accepts only lowercase hyphenated names", () => {
    expect(LearnedSkills.validName("release-yukioshi")).toBe(true)
    expect(LearnedSkills.validName("Release")).toBe(false)
    expect(LearnedSkills.validName("../escape")).toBe(false)
    expect(LearnedSkills.validName("a--b")).toBe(false)
    expect(LearnedSkills.validName("x".repeat(65))).toBe(false)
  })

  test("saves a skill file the skill loader can read, and archives the old version on update", async () => {
    const dir = await tempDir()
    const first = await LearnedSkills.save(dir, {
      name: "release-app",
      description: 'Cut a release: "bump, tag, push"',
      content: "1. bump\n2. tag",
    })
    expect(first).toEqual({ status: "saved", retired: [] })
    const text = await fs.readFile(path.join(dir, "release-app", "SKILL.md"), "utf8")
    expect(text).toStartWith('---\nname: release-app\ndescription: "Cut a release: \\"bump, tag, push\\""\n---\n')

    const second = await LearnedSkills.save(dir, { name: "release-app", description: "Cut a release", content: "new" })
    expect(second.status).toBe("updated")
    expect(await fs.readFile(path.join(dir, "release-app", "SKILL.md"), "utf8")).toContain("new")
    expect((await fs.readdir(path.join(dir, ".archive"))).length).toBe(1)
  })

  test("refuses a near-copy of an existing skill under a new name", async () => {
    const dir = await tempDir()
    await LearnedSkills.save(dir, {
      name: "fix-flaky-build",
      description: "Fix the flaky webpack build cache error on CI",
      content: "steps",
    })
    const copy = await LearnedSkills.save(dir, {
      name: "flaky-build-fix",
      description: "Fix the flaky webpack build cache error in CI",
      content: "steps",
    })
    expect(copy).toEqual({ status: "similar", similar: "fix-flaky-build" })
    expect(await exists(path.join(dir, "flaky-build-fix"))).toBe(false)

    const different = await LearnedSkills.save(dir, {
      name: "rotate-db-password",
      description: "Rotate the production database password",
      content: "steps",
    })
    expect(different.status).toBe("saved")
  })

  test("retires stale skills and the least used beyond the cap, never the one just saved", async () => {
    const dir = await tempDir()
    const start = 1_000 * DAY
    await LearnedSkills.save(dir, { name: "alpha", description: "alpha one", content: "a" }, start)
    await LearnedSkills.save(dir, { name: "beta", description: "beta two", content: "b" }, start)
    await LearnedSkills.recordUse(dir, "beta", start + 50 * DAY)

    // 100 days later "alpha" was never loaded: it is stale. "beta" was used 50 days ago and stays.
    const retired = await LearnedSkills.curate(dir, {}, start + 100 * DAY)
    expect(retired).toEqual(["alpha"])
    expect(await exists(path.join(dir, "alpha"))).toBe(false)
    expect(Object.keys(await LearnedSkills.readIndex(dir))).toEqual(["beta"])

    // With a cap of 1, saving a new skill retires the least used other skill.
    const result = await LearnedSkills.save(
      dir,
      { name: "gamma", description: "gamma three", content: "c", max: 1 },
      start + 101 * DAY,
    )
    expect(result).toEqual({ status: "saved", retired: ["beta"] })
    expect(Object.keys(await LearnedSkills.readIndex(dir))).toEqual(["gamma"])
  })

  test("remove archives a learned skill", async () => {
    const dir = await tempDir()
    await LearnedSkills.save(dir, { name: "temp-skill", description: "temporary", content: "x" })
    expect(await LearnedSkills.remove(dir, "temp-skill")).toBe(true)
    expect(await LearnedSkills.remove(dir, "temp-skill")).toBe(false)
    expect(await exists(path.join(dir, "temp-skill"))).toBe(false)
  })
})
