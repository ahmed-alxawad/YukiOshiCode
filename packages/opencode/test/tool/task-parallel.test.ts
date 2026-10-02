import { afterEach, describe, expect } from "bun:test"
import { existsSync } from "fs"
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

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskParallelTool } from "../../src/tool/task-parallel"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
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

describe("tool.task_parallel", () => {
  it.instance(
    "runs tasks concurrently, each against its own child session",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionID[] = []
        const tool = yield* TaskParallelTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            tasks: [
              { description: "task one", prompt: "do thing one", subagent_type: "general" },
              { description: "task two", prompt: "do thing two", subagent_type: "general" },
              { description: "task three", prompt: "do thing three", subagent_type: "general" },
            ],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(seen) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.count).toBe(3)
        expect(result.metadata.failed).toBe(0)
        expect(new Set(seen).size).toBe(3)
        expect(result.output).toContain('description="task one"')
        expect(result.output).toContain('description="task two"')
        expect(result.output).toContain('description="task three"')
        expect(result.output).toContain("done:")
      }),
    { git: true },
  )

  it.instance(
    "isolates a worktree=true task into its own git worktree directory",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionID[] = []
        const tool = yield* TaskParallelTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            tasks: [{ description: "isolated task", prompt: "edit a file", subagent_type: "general", worktree: true }],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(seen) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.failed).toBe(0)
        expect(result.output).toContain('worktree="')
      }),
    { git: true },
  )

  it.instance(
    "removes the git worktree directory after the task finishes",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionID[] = []
        const tool = yield* TaskParallelTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            tasks: [
              { description: "cleanup check task", prompt: "do something", subagent_type: "general", worktree: true },
            ],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(seen) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // Extract the worktree directory from the rendered output attribute worktree="..."
        const match = result.output.match(/worktree="([^"]+)"/)
        expect(match).not.toBeNull()
        const worktreeDir = match![1]!

        // The directory must have been removed by cleanup before execute() returned
        expect(existsSync(worktreeDir)).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "reports a per-task failure without failing the whole batch",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionID[] = []
        const tool = yield* TaskParallelTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            tasks: [
              { description: "ok task", prompt: "fine", subagent_type: "general" },
              { description: "bad task", prompt: "fine", subagent_type: "does-not-exist" },
            ],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(seen) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.count).toBe(2)
        expect(result.metadata.failed).toBe(1)
        expect(result.output).toContain("done:")
        expect(result.output).toContain("<task_error>")
      }),
    { git: true },
  )
})
