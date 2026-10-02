import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveConfigPath } from "@/cli/cmd/mcp"
import { tmpdir } from "../fixture/fixture"

test("MCP config defaults to YukiOshi JSONC", async () => {
  await using tmp = await tmpdir()
  expect(await resolveConfigPath(tmp.path, true)).toBe(path.join(tmp.path, "yukioshi.jsonc"))
})

test("MCP config prefers current JSONC and recognizes legacy filenames", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "yukioshi.json"), "{}")
  await Bun.write(path.join(tmp.path, "yukioshi.jsonc"), "{}")
  expect(await resolveConfigPath(tmp.path, true)).toBe(path.join(tmp.path, "yukioshi.jsonc"))

  await fs.rm(path.join(tmp.path, "yukioshi.json"))
  await fs.rm(path.join(tmp.path, "yukioshi.jsonc"))
  await Bun.write(path.join(tmp.path, "opencode.jsonc"), "{}")
  expect(await resolveConfigPath(tmp.path, true)).toBe(path.join(tmp.path, "opencode.jsonc"))
})

test("MCP project config recognizes current and legacy config directories", async () => {
  await using tmp = await tmpdir()
  const current = path.join(tmp.path, ".yukioshi", "yukioshi.jsonc")
  const legacy = path.join(tmp.path, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await Bun.write(legacy, "{}")
  expect(await resolveConfigPath(tmp.path)).toBe(legacy)

  await fs.mkdir(path.dirname(current), { recursive: true })
  await Bun.write(current, "{}")
  expect(await resolveConfigPath(tmp.path)).toBe(current)
})
