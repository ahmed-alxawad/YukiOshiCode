import { ConfigV1 } from "@yukioshi/core/v1/config/config"
import { Database } from "@yukioshi/core/database/database"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import fs from "fs"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@yukioshi/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance, noopBootstrapReplacement, trustProject } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@yukioshi/core/provider"
import { ModelV2 } from "@yukioshi/core/model"
import type { SessionID } from "../../src/session/schema"

// Steering: a message sent while a turn runs reaches the model at the next safe point of the same turn (after the
// running tool calls finish and their results are recorded, before the next model request). If the turn is already
// ending, the message starts the next turn; it is never dropped.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in steer tests"),
    authenticate: () => Effect.die("unexpected MCP auth in steer tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in steer tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    noopBootstrapReplacement,
  ]),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

function config(url: string): Partial<ConfigV1.Info> {
  return {
    model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const setup = Effect.fn("test.steer.setup")(function* (extra?: (dir: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(llm.url), ...extra?.(dir) }),
    ),
  )
  yield* trustProject(dir)
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Steer",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  return { dir, llm, prompt, sessions, chat }
})

// A "slow tool": a shell command that waits until the test creates a gate file, then prints a marker.
function slowTool(dir: string, gate: string, marker: string) {
  return {
    command: `while [ ! -f ${JSON.stringify(path.join(dir, gate))} ]; do sleep 0.05; done; printf ${marker}`,
    timeout: 20_000,
    workdir: dir,
    description: "wait for gate",
  }
}

const waitForRunningTool = (sessionID: SessionID) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
      const assistant = msgs.findLast((item) => item.info.role === "assistant")
      const running = assistant?.parts.some((part) => part.type === "tool" && part.state.status === "running")
      return running ? (true as const) : undefined
    }),
    "timed out waiting for the slow tool to start",
    "10 seconds",
  )

const waitForUser = (sessionID: SessionID, text: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
      const found = msgs.some(
        (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "text" && part.text === text),
      )
      return found ? (true as const) : undefined
    }),
    `timed out waiting for user message ${text}`,
    "10 seconds",
  )

const send = (prompt: SessionPrompt.Interface, sessionID: SessionID, text: string) =>
  prompt.prompt({ sessionID, agent: "build", model: ref, parts: [{ type: "text", text }] })

// Flattens one recorded model request into a list of "role: text" lines, tool calls and tool results included.
function transcript(input: Record<string, unknown>) {
  const messages = input.messages
  if (!Array.isArray(messages)) throw new Error("expected messages in the model request")
  return messages.flatMap((msg: any): string[] => {
    if (msg.role === "system") return []
    if (msg.role === "tool")
      return [`tool: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`]
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)
      return [`assistant: tool_call ${msg.tool_calls.map((call: any) => call.function?.name).join(",")}`]
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part.text ?? "").join("")
          : ""
    return [`${msg.role}: ${content}`]
  })
}

unix(
  "a message sent while a tool runs reaches the next model request of the same turn, after the tool result",
  () =>
    Effect.gen(function* () {
      const { dir, llm, prompt, chat } = yield* setup()
      yield* llm.tool("bash", slowTool(dir, "go", "TOOL-RESULT-MARKER"))
      yield* llm.text("done")

      const first = yield* send(prompt, chat.id, "first task").pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForRunningTool(chat.id)

      const second = yield* send(prompt, chat.id, "steer: use tabs").pipe(Effect.forkChild)
      yield* waitForUser(chat.id, "steer: use tabs")
      fs.writeFileSync(path.join(dir, "go"), "")

      const [a, b] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(Exit.isSuccess(a)).toBe(true)
      expect(Exit.isSuccess(b)).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const lines = transcript(inputs[1]!)
      const toolResult = lines.findIndex((line) => line.startsWith("tool:") && line.includes("TOOL-RESULT-MARKER"))
      const steer = lines.findIndex((line) => line.startsWith("user:") && line.includes("steer: use tabs"))
      expect(toolResult).toBeGreaterThan(-1)
      expect(steer).toBeGreaterThan(toolResult)
      expect(lines.at(-1)).toBe("user: steer: use tabs")
    }),
  { git: true },
  30_000,
)

unix(
  "a message sent while the finished turn is still wrapping up starts the next turn instead of being dropped",
  () =>
    Effect.gen(function* () {
      const { dir, llm, prompt, sessions, chat } = yield* setup((dir) => ({
        hooks: { stop: [{ command: `touch ${JSON.stringify(path.join(dir, "stop-started"))}; sleep 1` }] },
      }))
      const marker = path.join(dir, "stop-started")
      yield* llm.text("answer one")
      yield* llm.text("answer two")

      const first = yield* send(prompt, chat.id, "one").pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.sync(() => (fs.existsSync(marker) ? (true as const) : undefined)),
        "timed out waiting for the stop hook",
        "10 seconds",
      )
      const second = yield* send(prompt, chat.id, "two").pipe(Effect.forkChild)

      const [a, b] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(Exit.isSuccess(a)).toBe(true)
      expect(Exit.isSuccess(b)).toBe(true)
      expect(yield* llm.calls).toBe(2)
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const two = msgs.find(
        (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "text" && part.text === "two"),
      )
      const reply = msgs.findLast((msg) => msg.info.role === "assistant")
      if (!two || reply?.info.role !== "assistant") throw new Error("expected the second message and a reply")
      expect(reply.info.parentID).toBe(two.info.id)
      if (Exit.isSuccess(b)) expect(b.value.info.id).toBe(reply.info.id)
      // The running turn picks the message up itself, so the session does not go idle in between and the first
      // sender's call also ends with the latest reply.
      if (Exit.isSuccess(a)) expect(a.value.info.id).toBe(reply.info.id)
    }),
  { git: true },
  30_000,
)

unix(
  "two quick messages sent while a tool runs both reach the next model request, in the order they were sent",
  () =>
    Effect.gen(function* () {
      const { dir, llm, prompt, chat } = yield* setup()
      yield* llm.tool("bash", slowTool(dir, "go", "TOOL-RESULT-MARKER"))
      yield* llm.text("done")

      const first = yield* send(prompt, chat.id, "first task").pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForRunningTool(chat.id)

      const one = yield* send(prompt, chat.id, "steer one").pipe(Effect.forkChild)
      yield* waitForUser(chat.id, "steer one")
      const two = yield* send(prompt, chat.id, "steer two").pipe(Effect.forkChild)
      yield* waitForUser(chat.id, "steer two")
      fs.writeFileSync(path.join(dir, "go"), "")

      const exits = yield* Effect.all([Fiber.await(first), Fiber.await(one), Fiber.await(two)])
      for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const lines = transcript(inputs[1]!)
      const toolResult = lines.findIndex((line) => line.startsWith("tool:") && line.includes("TOOL-RESULT-MARKER"))
      expect(toolResult).toBeGreaterThan(-1)
      expect(lines.slice(toolResult + 1)).toEqual(["user: steer one", "user: steer two"])
    }),
  { git: true },
  30_000,
)

it.instance(
  "a message sent while the model streams text (no tool) is in the next model request",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, sessions, chat } = yield* setup()
      const gate = Promise.withResolvers<void>()
      yield* llm.hold("streamed answer", gate.promise)
      yield* llm.text("follow-up answer")

      const first = yield* send(prompt, chat.id, "first").pipe(Effect.forkChild)
      yield* llm.wait(1)
      const second = yield* send(prompt, chat.id, "follow-up").pipe(Effect.forkChild)
      yield* waitForUser(chat.id, "follow-up")
      gate.resolve()

      const [a, b] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(Exit.isSuccess(a)).toBe(true)
      expect(Exit.isSuccess(b)).toBe(true)
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(transcript(inputs[1]!)).toEqual(["user: first", "assistant: streamed answer", "user: follow-up"])
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const reply = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(reply?.parts.some((part) => part.type === "text" && part.text === "follow-up answer")).toBe(true)
    }),
  { git: true },
  30_000,
)

unix(
  "cancelling a turn does not answer a message that was waiting for it",
  () =>
    Effect.gen(function* () {
      const { dir, llm, prompt, chat } = yield* setup()
      yield* llm.tool("bash", slowTool(dir, "never", "UNUSED"))
      yield* llm.text("must not be requested")

      const first = yield* send(prompt, chat.id, "first task").pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForRunningTool(chat.id)
      const second = yield* send(prompt, chat.id, "waiting message").pipe(Effect.forkChild)
      yield* waitForUser(chat.id, "waiting message")
      yield* prompt.cancel(chat.id)

      const [a, b] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(Exit.isSuccess(a)).toBe(true)
      expect(Exit.isSuccess(b)).toBe(true)
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000,
)
