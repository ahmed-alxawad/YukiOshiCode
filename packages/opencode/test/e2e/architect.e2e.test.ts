import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { globalConfig, requestText, requestToolNames, runtimeEnv } from "./helpers"

function twoModels(url: string, extra: Record<string, unknown> = {}) {
  const base = testProviderConfig(url)
  const models = base.provider.test.models
  return JSON.stringify({
    ...base,
    provider: { test: { ...base.provider.test, models: { ...models, "editor-model": { ...models["test-model"], id: "editor-model", name: "Editor" } } } },
    ...extra,
  })
}

const PLAN = "PLAN-7731: in notes.txt replace the word old with new"

describe("architect/editor mode", () => {
  cliIt.live(
    "--architect: read-only planner request, then editor request with the plan and its own model",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "notes.txt")
        yield* llm.push(
          reply().tool("task", { description: "apply plan", prompt: PLAN, subagent_type: "architect-editor" }),
          reply().tool("write", { filePath: file, content: "new" }),
          reply().text("edited notes.txt").stop(),
          reply().text("The editor changed notes.txt").stop(),
        )
        const result = yield* opencode.run("change old to new", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url) },
          extraArgs: ["--architect", "test/test-model,test/editor-model"],
        })
        expect(result.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(4)
        const planner = requestToolNames(inputs[0]!)
        expect(planner).toContain("read")
        expect(planner).toContain("task")
        for (const tool of ["write", "edit", "bash", "patch", "apply_patch"]) expect(planner).not.toContain(tool)
        expect(inputs[0]!.model).toBe("test-model")
        expect(inputs[1]!.model).toBe("editor-model")
        expect(requestText(inputs[1]!)).toContain(PLAN)
        expect(requestToolNames(inputs[1]!).some((name) => name === "write" || name === "edit")).toBe(true)
        expect(fs.readFileSync(file, "utf8")).toBe("new")
        expect(result.stdout).toContain("The editor changed notes.txt")
      }),
    90_000,
  )

  cliIt.live(
    "parent deny rules still apply to the editor",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "blocked.txt")
        yield* llm.push(
          reply().tool("task", { description: "apply plan", prompt: PLAN, subagent_type: "architect-editor" }),
          reply().tool("write", { filePath: file, content: "x" }),
          reply().text("could not write").stop(),
          reply().text("done").stop(),
        )
        yield* opencode.run("change", {
          cwd: home,
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url, { permission: { edit: { "*": "deny" } } }),
          },
          extraArgs: ["--architect", "test/test-model,test/editor-model"],
        })
        expect(fs.existsSync(file)).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "global config architect.enabled turns it on; the same setting from a project config is ignored",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("ok").stop(), reply().text("ok").stop())
        const architect = { enabled: true, editor_model: "test/editor-model" }
        yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url, { architect }) },
        })
        expect(requestToolNames((yield* llm.inputs)[0]!)).toContain("write")
        globalConfig(home, { architect })
        yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url) },
        })
        const tools = requestToolNames((yield* llm.inputs)[1]!)
        expect(tools).toContain("task")
        expect(tools).not.toContain("write")
      }),
    90_000,
  )

  cliIt.live(
    "disabled by default: normal agent with edit tools",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        globalConfig(home, { architect: { editor_model: "test/editor-model" } })
        yield* llm.push(reply().text("ok").stop())
        yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url) },
        })
        const tools = requestToolNames((yield* llm.inputs)[0]!)
        expect(tools).toContain("write")
        expect(requestText((yield* llm.inputs)[0]!)).not.toContain("two-model workflow")
        yield* llm.push(reply().text("ok").stop())
        const named = yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url) },
          extraArgs: ["--agent", "architect"],
        })
        expect(named.exitCode).not.toBe(0)
        expect(named.stderr).toContain("Agent not found")
      }),
    90_000,
  )

  cliIt.live(
    "bad model strings give a clear error",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const flag = yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url) },
          extraArgs: ["--architect", "justamodel"],
        })
        expect(flag.exitCode).not.toBe(0)
        expect(flag.stderr).toContain("provider/model")
        const cfg = yield* opencode.run("hi", {
          cwd: home,
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: twoModels(llm.url, { architect: { enabled: true, planner_model: "bad" } }) },
        })
        expect(cfg.exitCode).not.toBe(0)
        expect(cfg.stderr + cfg.stdout).toContain("provider/model")
      }),
    90_000,
  )
})
