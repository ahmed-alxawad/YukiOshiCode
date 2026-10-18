import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { MemoryPaths } from "../../src/memory/paths"
import { MemoryStore } from "../../src/memory/store"
import { promptText } from "../../src/memory"

test("each agent gets its own memory directory, user or project scoped", () => {
  const ctx = { directory: "/work/app", worktree: "/work/app" }
  expect(MemoryPaths.agentRoot(ctx, "project", "Reviewer", "/data")).toBe("/work/app/.yukioshi/agent-memory/reviewer")
  expect(MemoryPaths.agentRoot(ctx, "user", "Reviewer", "/data")).toBe("/data/agent-memory/reviewer")
  expect(MemoryPaths.agentRoot(ctx, "user", "../../etc", "/data").startsWith("/data/agent-memory/")).toBe(true)
  expect(path.dirname(MemoryPaths.agentRoot(ctx, "user", "../../etc", "/data"))).toBe("/data/agent-memory")
})

test("an agent's memory file is separate from project memory and size-capped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-"))
  const agent = MemoryPaths.agentRoot({ directory: dir, worktree: dir }, "project", "reviewer", dir)
  const project = path.join(dir, "project-memory")
  expect((await MemoryStore.remember({ root: agent, file: "project.md", text: "uses tabs", maxChars: 60 })).changed).toBe(true)
  const full = await MemoryStore.remember({ root: agent, file: "project.md", text: "x".repeat(80), key: "big", maxChars: 60 })
  expect(full.changed).toBe(false)
  expect(full.full?.max).toBe(60)
  expect(await Bun.file(path.join(agent, "project.md")).text()).toContain("uses tabs")
  expect(await Bun.file(path.join(project, "project.md")).exists()).toBe(false)
  const { bySource } = await MemoryStore.catalog({ root: agent })
  expect(promptText(bySource, 4000)).toContain("uses tabs")
  expect(promptText(bySource, 4000)).not.toContain("x".repeat(80))
})
