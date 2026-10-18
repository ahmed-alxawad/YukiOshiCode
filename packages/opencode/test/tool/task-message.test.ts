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

import { type TaskPromptOps } from "../../src/tool/task"
import { TaskMessageTool } from "../../src/tool/task-message"
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

const off = testEffect(layer())
const on = testEffect(layer({ experimentalBackgroundSubagents: true }))


function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

const context = (chatID: SessionID, messageID: MessageID, promptOps: TaskPromptOps) => ({
  sessionID: chatID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.task_message", () => {
  on.instance("resumes a finished subagent by task_id and delivers the reply to the parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "general" })
      const def = yield* (yield* TaskMessageTool).init()
      const sent = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "ok"))
          }
          sent.resolve(input)
          return Effect.succeed(reply(input, "follow-up done"))
        },
      }
      const result = yield* def.execute(
        { task_id: child.id, message: "also check the cache" },
        context(chat.id, assistant.id, promptOps),
      )
      expect(result.output).toContain(`<task id="${child.id}" state="running">`)
      const seen = yield* Effect.promise(() => sent.promise)
      expect(seen.sessionID).toBe(child.id)
      expect(seen.agent).toBe("general")
      expect(seen.parts).toEqual([{ type: "text", text: "also check the cache" }])
      expect((yield* jobs.wait({ id: child.id, timeout: 1_000 })).info?.output).toBe("follow-up done")
      const note = yield* Effect.promise(() => injected.promise)
      expect(note.parts[0]?.type === "text" && note.parts[0].text).toContain("follow-up done")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  on.instance("finds the subagent by a unique agent name and rejects ambiguous or unknown ones", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      yield* sessions.create({ parentID: chat.id, title: "one", agent: "explore" })
      yield* sessions.create({ parentID: chat.id, title: "a", agent: "general" })
      yield* sessions.create({ parentID: chat.id, title: "b", agent: "general" })
      const def = yield* (yield* TaskMessageTool).init()
      const ctx = context(chat.id, assistant.id, stubOps())
      const ok = yield* def.execute({ task_id: "explore", message: "hi" }, ctx)
      expect(ok.metadata.sessionId).toMatch(/^ses_/)
      const ambiguous = yield* def.execute({ task_id: "general", message: "hi" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(ambiguous)).toBe(true)
      expect(Exit.isFailure(ambiguous) ? Cause.pretty(ambiguous.cause) : "").toContain("More than one subagent")
      const unknown = yield* def.execute({ task_id: "ses_missing", message: "hi" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)
      expect(Exit.isFailure(unknown) ? Cause.pretty(unknown.cause) : "").toContain("Unknown task_id")
    }),
  )

  on.instance("is denied from inside a subagent at the default depth", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child", agent: "general" })
      const def = yield* (yield* TaskMessageTool).init()
      const exit = yield* def
        .execute({ task_id: "general", message: "hi" }, context(child.id, MessageID.ascending(), stubOps()))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("subagent_depth")
    }),
  )

  off.instance("is refused while background subagents are off", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskMessageTool).init()
      const exit = yield* def.execute({ task_id: "x", message: "hi" }, context(chat.id, assistant.id, stubOps())).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("background subagents")
    }),
  )
})
