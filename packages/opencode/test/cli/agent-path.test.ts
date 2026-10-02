import { expect, test } from "bun:test"
import path from "node:path"
import { agentTargetDirectory } from "../../src/cli/cmd/agent"

test("agent creation uses YukiOshi project paths and preserves explicit paths", () => {
  expect(
    agentTargetDirectory({
      scope: "project",
      worktree: "/workspace",
      globalConfig: "/config/yukioshi",
    }),
  ).toBe(path.join("/workspace", ".yukioshi", "agents"))
  expect(
    agentTargetDirectory({
      scope: "global",
      worktree: "/workspace",
      globalConfig: "/config/yukioshi",
    }),
  ).toBe(path.join("/config/yukioshi", "agents"))
  expect(agentTargetDirectory({ path: "/custom" })).toBe(path.join("/custom", "agents"))
})
