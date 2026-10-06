import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { runtimeEnv } from "./helpers"

const bundled = [
  "bugfix",
  "customize-opencode",
  "design:accessibility-review",
  "design:design-critique",
  "design:design-handoff",
  "design:design-system",
  "design:research-synthesis",
  "design:user-research",
  "design:ux-copy",
  "disaster",
  "engineering:architecture",
  "engineering:code-review",
  "engineering:debug",
  "engineering:deploy-checklist",
  "engineering:documentation",
  "engineering:incident-response",
  "engineering:standup",
  "engineering:system-design",
  "engineering:tech-debt",
  "engineering:testing-strategy",
  "nightmare",
  "productivity:memory-management",
  "productivity:start",
  "productivity:task-management",
  "productivity:update",
  "skill-creator",
  "web-artifacts-builder",
]

describe("piped output", () => {
  cliIt.live(
    "debug skill piped output is complete JSON with every bundled skill",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["debug", "skill"], { env: runtimeEnv(home) })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.length).toBeGreaterThan(64_000)
        const parsed = JSON.parse(result.stdout) as Array<{ name: string }>
        expect(parsed.map((skill) => skill.name).sort()).toEqual(bundled)
      }),
    60_000,
  )
})
