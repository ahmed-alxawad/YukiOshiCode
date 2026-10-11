import { afterEach, describe, expect } from "bun:test"
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
import { TaskParallelTool } from "../../src/tool/task-parallel"
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

const context = (chat: Session.Info, assistant: SessionV1.Assistant, seen: SessionID[], asked: string[], refuse: boolean) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps: stubOps(seen) },
  messages: [],
  metadata: () => Effect.void,
  ask: (request: { permission: string }) => {
    asked.push(request.permission)
    return request.permission === "task_parallel" && refuse ? Effect.die(new Error("refused")) : Effect.void
  },
})

describe("tool.task_parallel permission for worktrees", () => {
  it.instance(
    "a refused worktree permission creates no worktree and starts no task",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const instance = yield* InstanceState.context
        const seen: SessionID[] = []
        const asked: string[] = []
        const def = yield* (yield* TaskParallelTool).init()
        const before = git(instance.directory, "worktree", "list")
        const exit = yield* def
          .execute(
            { tasks: [{ description: "isolated", prompt: "edit", subagent_type: "general", worktree: true }] },
            context(chat, assistant, seen, asked, true),
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(asked).toEqual(["task_parallel"])
        expect(seen).toEqual([])
        expect(git(instance.directory, "worktree", "list")).toBe(before)
      }),
    { git: true },
  )

  it.instance(
    "tasks without a worktree do not ask for it",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionID[] = []
        const asked: string[] = []
        const def = yield* (yield* TaskParallelTool).init()
        yield* def.execute(
          { tasks: [{ description: "plain", prompt: "look", subagent_type: "general" }] },
          context(chat, assistant, seen, asked, true),
        )
        expect(asked).not.toContain("task_parallel")
        expect(seen).toHaveLength(1)
      }),
    { git: true },
  )
})
