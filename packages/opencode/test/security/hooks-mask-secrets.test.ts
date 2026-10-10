import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Hooks } from "@/hooks"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

function withCwd<A, E, R>(fn: (cwd: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const cwd = yield* tmpdirScoped()
    return yield* fn(cwd)
  })
}

describe("hooks", () => {
  it("the stdin payload holds no secret from the prompt or tool input", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const out = path.join(cwd, "stdin.txt")
        const script = `bun -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" ${JSON.stringify(out)}`
        const cfg: ConfigHooksV1.Info = { preToolUse: [{ matcher: "*", command: script }] }
        const result = yield* hooks.run({
          hooks: cfg,
          event: "PreToolUse",
          payload: { prompt: `use ${openai}`, tool_input: { command: `curl --token ${github} https://x.io` }, ok: "keep" },
          cwd,
          toolName: "bash",
        })
        expect(result.ran).toBe(1)
        const seen = fs.readFileSync(out, "utf8")
        expect(seen).not.toContain(openai)
        expect(seen).not.toContain(github)
        expect(seen).toContain("keep")
      }),
    ),
  )

  it("credentials in the environment are not passed to the hook", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const out = path.join(cwd, "env.txt")
        const names = ["AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "STRIPE_PRIVATE_KEY", "GITHUB_TOKEN"]
        for (const name of names) process.env[name] = "fake-value-for-" + name
        try {
          const script = `bun -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))" ${JSON.stringify(out)}`
          yield* hooks.run({
            hooks: { preToolUse: [{ matcher: "*", command: script }] },
            event: "PreToolUse",
            payload: {},
            cwd,
            toolName: "bash",
          })
        } finally {
          for (const name of names) delete process.env[name]
        }
        const env = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, string>
        for (const name of names) expect(env[name] ?? "").toBe("")
      }),
    ),
  )

  it("what a hook prints back to the model is masked", () =>
    withCwd((cwd) =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.Service
        const blocked = yield* hooks.run({
          hooks: {
            preToolUse: [{ matcher: "*", command: `bun -e "process.stderr.write('denied for ${github}'); process.exit(2)"` }],
          },
          event: "PreToolUse",
          payload: {},
          cwd,
          toolName: "bash",
        })
        expect(blocked.blocked).toContain("denied for")
        expect(blocked.blocked).not.toContain(github)

        const context = yield* hooks.run({
          hooks: { userPromptSubmit: [{ command: `echo OPENAI_API_KEY=${openai}` }] },
          event: "UserPromptSubmit",
          payload: {},
          cwd,
        })
        expect(context.context.join("\n")).not.toContain(openai)
      }),
    ),
  )
})
