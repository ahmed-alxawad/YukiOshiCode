import { afterEach, describe, expect } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { Database } from "@yukioshi/core/database/database"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Worktree } from "../../src/worktree"
import { Git } from "../../src/git"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, noopBootstrapReplacement } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@yukioshi/core/provider"
import { ModelV2 } from "@yukioshi/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
    Worktree.node,
    Git.node,
  ]),
  [noopBootstrapReplacement],
)

const it = testEffect(layer)

const seed = Effect.fn("TaskParallelToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

// Each stubbed reply echoes the session ID it ran against, so a test can prove N concurrent
// subagent calls each actually got their own distinct child session (not a shared/reused one).
function stubOps(seen: SessionID[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        seen.push(input.sessionID)
        return reply(input, `done:${input.sessionID}`)
      }),
  }
}

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

// A subagent stub that works in the folder its session runs in: it records whether the project's files were
// there when it started, then makes (and optionally commits) a change.
function editingOps(seen: string[], options: { commit?: boolean } = {}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const directory = yield* InstanceState.directory
        seen.push(existsSync(path.join(directory, "base.txt")) ? "checked out" : "empty")
        writeFileSync(path.join(directory, "made.txt"), "work")
        if (options.commit) {
          git(directory, "add", "made.txt")
          git(directory, "commit", "-qm", "subagent work")
        }
        return reply(input, "made a file")
      }),
  }
}

const commitBase = Effect.fn("TaskParallelToolTest.commitBase")(function* () {
  const directory = yield* InstanceState.directory
  writeFileSync(path.join(directory, "base.txt"), "base")
  git(directory, "add", "base.txt")
  git(directory, "commit", "-qm", "base")
  return directory
})


function fields(seen: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        seen.push(input)
        const directory = yield* InstanceState.directory
        writeFileSync(path.join(directory, "made.txt"), "work")
        return reply(input, "ok")
      }),
  }
}

const run = (subagent: string, ops: TaskPromptOps) =>
  Effect.gen(function* () {
    const { chat, assistant } = yield* seed()
    const tool = yield* TaskTool
    const def = yield* tool.init()
    return yield* def.execute(
      { description: "field check", prompt: "do it", subagent_type: subagent },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: ops },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
  })

const agents = {
  bg: { mode: "subagent", description: "bg", background: true },
  iso: { mode: "subagent", description: "iso", isolation: "worktree" },
  init: { mode: "subagent", description: "init", initialPrompt: "Read the plan first." },
  eff: { mode: "subagent", description: "eff", effort: "max" },
} as const

describe("task tool agent fields", () => {
  it.instance(
    "background: true starts the agent in the background when subagents.background is on",
    () =>
      Effect.gen(function* () {
        const result = yield* run("bg", fields([]))
        expect(result.output).toContain("Background task started")
      }),
    { git: true, config: { subagents: { background: true }, agent: agents } },
  )

  it.instance(
    "background: true is ignored when subagents.background is off",
    () =>
      Effect.gen(function* () {
        const result = yield* run("bg", fields([]))
        expect(result.output).not.toContain("Background task started")
        expect(result.output).toContain('state="completed"')
      }),
    { git: true, config: { agent: agents } },
  )

  it.instance(
    "isolation: worktree runs in a separate worktree and keeps one with changes",
    () =>
      Effect.gen(function* () {
        const main = yield* InstanceState.directory
        const result = yield* run("iso", fields([]))
        const match = result.output.match(/kept in (\S+)/)
        expect(match).not.toBeNull()
        expect(existsSync(path.join(match![1]!, "made.txt"))).toBe(true)
        expect(existsSync(path.join(main, "made.txt"))).toBe(false)
        expect(result.output).toContain("<worktree_changes>")
      }),
    { git: true, config: { subagents: { parallel: true }, agent: agents } },
  )

  it.instance(
    "isolation: worktree is ignored when subagents.parallel is off",
    () =>
      Effect.gen(function* () {
        const main = yield* InstanceState.directory
        const result = yield* run("iso", fields([]))
        expect(result.output).not.toContain("<worktree_changes>")
        expect(existsSync(path.join(main, "made.txt"))).toBe(true)
      }),
    { git: true, config: { agent: agents } },
  )

  it.instance(
    "initialPrompt is prepended to the subagent's first message",
    () =>
      Effect.gen(function* () {
        const seenInputs: SessionPrompt.PromptInput[] = []
        yield* run("init", fields(seenInputs))
        const texts = seenInputs[0]!.parts.map((part) => (part.type === "text" ? part.text : ""))
        expect(texts[0]).toContain("Read the plan first.")
        expect(texts.at(-1)).toBe("do it")
      }),
    { git: true, config: { agent: agents } },
  )

  it.instance(
    "effort maps to the agent variant",
    () =>
      Effect.gen(function* () {
        const found = yield* Agent.Service.use((svc) => svc.get("eff"))
        expect(found.variant).toBe("max")
      }),
    { git: true, config: { agent: agents } },
  )
})
