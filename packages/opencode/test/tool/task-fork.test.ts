import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { Database } from "@yukioshi/core/database/database"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
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

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
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

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
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
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)], noopBootstrapReplacement],
  )

const it = testEffect(layer())

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
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

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
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
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}


const addText = Effect.fn("ForkTest.addText")(function* (sessionID: SessionID, text: string, big = 0) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({ id: PartID.ascending(), messageID: user.id, sessionID, type: "text", text })
  if (!big) return user
  {
    const asst = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: asst.id,
      sessionID,
      type: "tool",
      callID: "c1",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "x".repeat(big),
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    return asst
  }
})

const run = Effect.fn("ForkTest.run")(function* (
  fork: boolean | undefined,
  setup?: (chat: { id: SessionID }) => Effect.Effect<void, any, any>,
  subagent_type = "general",
) {
  const sessions = yield* Session.Service
  const { chat } = yield* seed()
  yield* addText(chat.id, "earlier message sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
  if (setup) yield* setup(chat)
  const callID = (yield* addText(chat.id, "call", 1)).id as MessageID
  const def = yield* (yield* TaskTool).init()
  let seen: SessionPrompt.PromptInput | undefined
  const result = yield* def
    .execute(
      { description: "d", prompt: "do it", subagent_type, ...(fork === undefined ? {} : { fork }) },
      {
        sessionID: chat.id,
        messageID: callID,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    .pipe(Effect.exit)
  const children = yield* sessions.children(chat.id)
  const child = children[0]
  const msgs = child ? yield* sessions.messages({ sessionID: child.id }) : []
  return { result, child, msgs, seen }
})

const texts = (msgs: SessionV1.WithParts[]) =>
  msgs.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
const on = { config: { subagents: { fork: true } } }

describe("task fork mode", () => {
  it.instance(
    "fork child inherits parent messages, masked",
    () =>
      Effect.gen(function* () {
        const { result, msgs } = yield* run(true)
        expect(Exit.isSuccess(result)).toBe(true)
        const all = texts(msgs).join("\n")
        expect(all).toContain("earlier message")
        expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789")
      }),
    on,
  )

  it.instance(
    "non-fork child does not inherit",
    () =>
      Effect.gen(function* () {
        const { result, msgs } = yield* run(undefined)
        expect(Exit.isSuccess(result)).toBe(true)
        expect(texts(msgs).join("\n")).not.toContain("earlier message")
      }),
    on,
  )

  it.instance("fork is refused when the config is off", () =>
    Effect.gen(function* () {
      const { result, child } = yield* run(true)
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(Cause.squash((result as Exit.Failure<any, any>).cause))).toContain("Fork mode is off")
      expect(child).toBeUndefined()
    }),
  )

  it.instance(
    "fork child cannot start subagents",
    () =>
      Effect.gen(function* () {
        const { child } = yield* run(true)
        const rules = child?.permission ?? []
        for (const permission of ["task", "task_parallel"])
          expect(rules.some((r) => r.permission === permission && r.pattern === "*" && r.action === "deny")).toBe(true)
      }),
    { config: { subagent_depth: 5, subagents: { fork: true } } },
  )

  it.instance(
    "fork child inherits parent deny rules",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { child } = yield* run(true, (chat) =>
          sessions.setPermission({ sessionID: chat.id, permission: [{ permission: "bash", pattern: "rm *", action: "deny" }] }),
        )
        expect(child?.permission?.some((r) => r.permission === "bash" && r.pattern === "rm *" && r.action === "deny")).toBe(true)
      }),
    on,
  )

  it.instance(
    "history is capped by compacting oldest tool outputs",
    () =>
      Effect.gen(function* () {
        const { msgs } = yield* run(true, (chat) =>
          Effect.gen(function* () {
            yield* addText(chat.id, "old", 2_000_000)
            yield* addText(chat.id, "new", 40_000)
          }),
        )
        const tools = msgs.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? [p] : [])))
        expect(tools.length).toBe(2)
        expect(tools[0].state.status === "completed" && !!tools[0].state.time.compacted).toBe(true)
        expect(tools[1].state.status === "completed" && !!tools[1].state.time.compacted).toBe(false)
      }),
    on,
  )

  it.instance(
    "agent definition fork:true forks",
    () =>
      Effect.gen(function* () {
        const { msgs } = yield* run(undefined, undefined, "forky")
        expect(texts(msgs).join("\n")).toContain("earlier message")
      }),
    { config: { subagents: { fork: true }, agent: { forky: { mode: "subagent", description: "f", fork: true } } } },
  )
})
